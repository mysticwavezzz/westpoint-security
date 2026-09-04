// Thin wrapper around the S3 client for Cloudflare R2 (R2 speaks the S3 API).
// All bodycam video - live chunks and the final merged file - lives here,
// not on the Railway Volume, since video grows far faster than a Volume is
// sized for and R2 has no egress fees.

const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  return client;
}

function bucket() {
  return process.env.R2_BUCKET_NAME || 'westpoint-bodycam';
}

function isConfigured() {
  return !!getClient();
}

async function putObject(key, body, contentType) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  await s3.send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream'
  }));
}

async function getObjectStream(key) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return { stream: res.Body, contentLength: res.ContentLength, contentType: res.ContentType };
}

async function listObjects(prefix) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  const out = [];
  let continuationToken;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return out.sort();
}

// Same as listObjects but keeps each object's size - used for tracking total
// bucket usage against the free-tier storage cap without a separate
// Class B/HeadObject call per object.
async function listObjectsWithSize(prefix) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  const out = [];
  let continuationToken;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    (res.Contents || []).forEach(o => out.push({ key: o.Key, size: o.Size || 0 }));
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

// Total bytes across the whole bucket - a full ListObjectsV2 walk (a Class A
// operation), so this is meant to be called sparingly (on boot, then on a
// long interval) and kept in a running in-memory counter otherwise, not
// called on every upload.
async function getBucketTotalBytes() {
  const all = await listObjectsWithSize('');
  return all.reduce((sum, o) => sum + o.size, 0);
}

async function deleteObjects(keys) {
  const s3 = getClient();
  if (!s3 || keys.length === 0) return;
  // S3-compatible batch delete caps at 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket(),
      Delete: { Objects: batch.map(Key => ({ Key })) }
    }));
  }
}

// A time-limited URL the browser can fetch/play directly - avoids proxying
// video bytes through the Node server twice (in from R2, out to the viewer).
// Pass downloadFilename to force a "Save As" download (via a
// Content-Disposition override) instead of the browser just playing the
// video inline, which is what a bare video/mp4 link does by default.
async function presignedGetUrl(key, expiresInSeconds = 3600, downloadFilename = null) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ...(downloadFilename ? { ResponseContentDisposition: `attachment; filename="${downloadFilename.replace(/"/g, '')}"` } : {})
  });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

module.exports = { isConfigured, putObject, getObjectStream, listObjects, listObjectsWithSize, getBucketTotalBytes, deleteObjects, presignedGetUrl };
