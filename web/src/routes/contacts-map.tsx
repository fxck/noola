import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin } from "lucide-react";
import { type ContactGeoPoint, fetchContactGeoPoints, isContactsUnavailable } from "@/lib/contacts";
import { isDarkNow } from "@/lib/theme";
import { CustomersViewSwitch } from "@/components/customers/view-switch";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";

// Customers → Map: every contact carrying IP-derived city-level coordinates, plotted and clustered
// (Intercom parity). One request loads the whole plottable set; MapLibre's GeoJSON source does the
// clustering on the client, so panning/zooming re-buckets without a round-trip. Coordinates are
// city centroids, so many contacts share a point — the clusters are the honest read of "where".

// Key-free CARTO basemaps, one per theme so the map reads in light and dark like the rest of the app.
const BASEMAP = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
} as const;

const SRC = "contacts";
const ACCENT = "#6366f1"; // indigo — the unclustered-pin + cluster fill

type LoadState = "loading" | "ok" | "error" | "unavailable";

/** points → a FeatureCollection MapLibre can cluster. Carries the id/name/company/city on each
 *  feature so a click can render the popup and deep-link without a second lookup. */
function toGeoJSON(points: ContactGeoPoint[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        name: p.name?.trim() || "Unnamed",
        company: p.company || "",
        place: [p.city, p.country].filter(Boolean).join(", "),
      },
    })),
  };
}

/** The three data layers over the basemap: cluster bubbles, cluster counts, and single pins. Added
 *  after every style load (a theme swap resets the style, dropping custom layers), so it's a fn. */
function addLayers(map: maplibregl.Map): void {
  if (map.getLayer("clusters")) return; // already present on this style
  map.addLayer({
    id: "clusters",
    type: "circle",
    source: SRC,
    filter: ["has", "point_count"],
    paint: {
      // Bubble grows and warms with the number of contacts it stands for.
      "circle-color": ["step", ["get", "point_count"], ACCENT, 10, "#8b5cf6", 50, "#d946ef"],
      "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 30],
      "circle-opacity": 0.85,
      "circle-stroke-width": 2,
      "circle-stroke-color": "rgba(255,255,255,0.55)",
    },
  });
  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: SRC,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
      "text-size": 12,
    },
    paint: { "text-color": "#ffffff" },
  });
  map.addLayer({
    id: "unclustered",
    type: "circle",
    source: SRC,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ACCENT,
      "circle-radius": 7,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
}

export function ContactsMapPage() {
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;

  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [points, setPoints] = useState<ContactGeoPoint[]>([]);
  const geojson = useMemo(() => toGeoJSON(points), [points]);

  // Load the plottable set once.
  useEffect(() => {
    let live = true;
    fetchContactGeoPoints()
      .then((p) => { if (live) { setPoints(p); setState("ok"); } })
      .catch((e) => { if (live) setState(isContactsUnavailable(e) ? "unavailable" : "error"); });
    return () => { live = false; };
  }, []);

  // Build the map once the container exists and data is in (so the first paint already has pins).
  useEffect(() => {
    if (state !== "ok" || !holder.current || mapRef.current) return;
    const dark = isDarkNow();
    const map = new maplibregl.Map({
      container: holder.current,
      style: dark ? BASEMAP.dark : BASEMAP.light,
      center: [8, 30],
      zoom: 1.4,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const install = (): void => {
      if (!map.isStyleLoaded()) return; // a later styledata fires once the (swapped) style is ready
      try {
        if (!map.getSource(SRC)) {
          map.addSource(SRC, { type: "geojson", data: geojson, cluster: true, clusterRadius: 48, clusterMaxZoom: 12 });
        }
        addLayers(map);
      } catch {
        /* style mid-load — the next styledata retries */
      }
    };
    map.on("load", install);
    // A theme swap calls setStyle, which wipes the source+layers — re-install on the new style.
    map.on("styledata", install);

    // Cluster click → zoom to the cluster's expansion level.
    map.on("click", "clusters", (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0] as MapGeoJSONFeature | undefined;
      if (!f) return;
      const clusterId = f.properties?.cluster_id as number;
      const src = map.getSource(SRC) as GeoJSONSource;
      void src.getClusterExpansionZoom(clusterId).then((zoom) => {
        map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
      });
    });

    // Single pin click → a popup that deep-links to the contact (SPA nav, no reload).
    map.on("click", "unclustered", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as { id: string; name: string; company: string; place: string };
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const wrap = document.createElement("div");
      wrap.className = "cm-pop";
      wrap.innerHTML =
        `<button type="button" class="cm-pop-btn">` +
        `<span class="cm-pop-name"></span>` +
        (props.company ? `<span class="cm-pop-sub"></span>` : "") +
        (props.place ? `<span class="cm-pop-place"></span>` : "") +
        `</button>`;
      wrap.querySelector(".cm-pop-name")!.textContent = props.name;
      if (props.company) wrap.querySelector(".cm-pop-sub")!.textContent = props.company;
      if (props.place) wrap.querySelector(".cm-pop-place")!.textContent = props.place;
      wrap.querySelector(".cm-pop-btn")!.addEventListener("click", () => {
        navRef.current({ to: "/contacts/$contactId", params: { contactId: props.id } });
      });
      new maplibregl.Popup({ closeButton: true, offset: 12 }).setLngLat([lng, lat]).setDOMContent(wrap).addTo(map);
    });

    const pointer = (v: boolean) => () => { map.getCanvas().style.cursor = v ? "pointer" : ""; };
    for (const layer of ["clusters", "unclustered"]) {
      map.on("mouseenter", layer, pointer(true));
      map.on("mouseleave", layer, pointer(false));
    }

    return () => { map.remove(); mapRef.current = null; };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps -- geojson pushed via the effect below

  // Push fresh data into a live source (e.g. if points reload) without rebuilding the map.
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource(SRC) as GeoJSONSource | undefined;
    if (src) src.setData(geojson);
  }, [geojson]);

  // Follow theme toggles: swap the basemap; the styledata handler re-installs source+layers.
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => {
      const map = mapRef.current;
      if (map) map.setStyle(isDarkNow() ? BASEMAP.dark : BASEMAP.light);
    });
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const plotted = points.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4">
        <h1 className="text-sm font-semibold tracking-tight">Customers</h1>
        <CustomersViewSwitch current="map" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {state === "loading" ? "loading…" : state === "ok" ? `${plotted.toLocaleString()} located` : ""}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        {state === "loading" && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner className="size-5" />
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 grid place-items-center">
            <ErrorState title="Couldn't load the map" onRetry={() => { setState("loading"); location.reload(); }} />
          </div>
        )}
        {(state === "unavailable" || (state === "ok" && plotted === 0)) && (
          <div className="absolute inset-0 grid place-items-center">
            <EmptyState
              icon={MapPin}
              title="No one to place yet"
              description="Contacts get a location once they're seen through the messenger (IP geolocation). As people write in, they'll appear here."
            />
          </div>
        )}
        {/* The map canvas — always mounted once data is in; overlays sit above it. */}
        <div ref={holder} className="absolute inset-0" />
      </div>
    </div>
  );
}
