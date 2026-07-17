import { api, API_URL } from "@/lib/api";

// Avatar upload + display helpers. Avatars are stored server-side and referenced by an
// API-relative path (e.g. "/avatar/<uuid>.jpg"); the browser resizes + re-encodes to JPEG
// client-side before upload so we never ship a multi-megabyte original.

/** Turn a stored API-relative avatar path into a full, displayable URL. */
export function avatarSrc(url: string | null | undefined): string | undefined {
  return url ? API_URL + url : undefined;
}

const MAX_DIM = 256;
const JPEG_QUALITY = 0.85;

/** Load a File into an HTMLImageElement via an object URL, revoking it once decoded. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image."));
    };
    img.src = url;
  });
}

/** Resize (fit, aspect-preserving) to at most 256×256 and export a JPEG data URL. */
async function toResizedDataUrl(file: File): Promise<string> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process that image.");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/**
 * Upload an avatar image. Omit `contactId` to set the signed-in user's own avatar;
 * pass one to set that contact's. Returns the new API-relative avatar path.
 */
export async function uploadAvatar(file: File, contactId?: string): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
  const image = await toResizedDataUrl(file);
  const { avatarUrl } = await api<{ avatarUrl: string }>("/uploads/avatar", {
    method: "POST",
    body: JSON.stringify({ image, ...(contactId ? { contactId } : {}) }),
  });
  return avatarUrl;
}
