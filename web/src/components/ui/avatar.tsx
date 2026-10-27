import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { initials, avatarHue } from "@/lib/tickets";

/** Initials avatar. `unassigned` renders a dashed ghost ring instead of a filled disc.
 *  When `image` is set, the photo renders instead of initials — falling back to the
 *  initials render if the image fails to load. */
export function Avatar({
  name,
  className,
  image,
  unassigned = false,
}: {
  name?: string | null;
  className?: string;
  /** Full image src (e.g. from `avatarSrc(url)`). Falls back to initials on load error. */
  image?: string | null;
  unassigned?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  // A fresh src (e.g. after re-upload) gets another chance to load.
  useEffect(() => setBroken(false), [image]);

  if (image && !broken) {
    return (
      <span
        className={cn("relative grid size-7 place-items-center overflow-hidden rounded-full", className)}
        aria-hidden
      >
        <img
          src={image}
          alt=""
          className="size-full rounded-full object-cover"
          onError={() => setBroken(true)}
        />
      </span>
    );
  }

  if (unassigned) {
    return (
      <span
        className={cn(
          "grid size-7 place-items-center rounded-full border border-dashed border-border text-micro font-medium text-muted-foreground",
          className,
        )}
        aria-hidden
      >
        —
      </span>
    );
  }
  // Identity color — a deterministic desaturated hue per name. A soft tinted disc
  // (not a saturated block): readable in both themes, and it turns an anonymous
  // roster into recognizable people/companies at a glance.
  const hue = avatarHue(name);
  return (
    <span
      className={cn(
        "grid size-7 place-items-center rounded-full text-micro font-semibold",
        className,
      )}
      style={{
        backgroundColor: `hsl(${hue} 42% 45%)`,
        color: "#fff",
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
