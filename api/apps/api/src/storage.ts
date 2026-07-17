import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

// Object-storage (Zerops MinIO / S3). forcePathStyle + an explicit region are
// required for MinIO. Keys are tenant-prefixed so a stray listing can't cross
// tenants; presigned URLs let the browser upload/download without proxying bytes.

const s3 = new S3Client({
  region: process.env.STORAGE_REGION ?? "us-east-1",
  endpoint: process.env.STORAGE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY ?? "",
    secretAccessKey: process.env.STORAGE_SECRET_KEY ?? "",
  },
});
const BUCKET = process.env.STORAGE_BUCKET ?? "";

/** Presigned PUT for a real attachment upload (browser uploads directly). */
export async function presignUpload(
  tenantId: string,
  filename: string,
  contentType: string,
): Promise<{ key: string; uploadUrl: string }> {
  const key = `${tenantId}/${crypto.randomUUID()}-${filename}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 900 },
  );
  return { key, uploadUrl };
}

/** Server-side store of a document's raw text (the ingestion pipeline keeps the
 *  original so a document can be re-extracted/re-chunked as the pipeline evolves). */
export async function putText(key: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/** Read an object's text back (re-extraction / retrieval of the raw source). */
/** Presigned GET — lets the browser fetch the object directly (range requests included,
 *  which <video> scrubbing needs). Short-lived; the api route is the authorization gate. */
export async function presignDownload(key: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function getText(key: string): Promise<string> {
  const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return (await got.Body?.transformToString()) ?? "";
}

/** Server-side store of raw bytes (e.g. an uploaded avatar image the API proxies). */
export async function putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/** Read an object's raw bytes + content-type (for serving an avatar back to the browser). */
export async function getObject(
  key: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await got.Body?.transformToByteArray();
    if (!bytes) return null;
    return { body: Buffer.from(bytes), contentType: got.ContentType ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Wiring smoke: round-trip a tiny object to prove the bucket is reachable. */
export async function storageSmoke(): Promise<{ ok: boolean; roundtrip: boolean; bucket: string }> {
  const key = `_smoke/${crypto.randomUUID()}.txt`;
  const payload = `switchboard-smoke ${new Date(0).toISOString()}`;
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: payload, ContentType: "text/plain" }),
  );
  const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await got.Body?.transformToString();
  return { ok: true, roundtrip: body === payload, bucket: BUCKET };
}
