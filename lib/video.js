// ffmpeg helpers for the bodycam pipeline.
//
// Merging uses stream copy (-c copy), not a re-encode: every chunk is
// already VP8/webm from the browser's MediaRecorder, at the same
// resolution/codec since they all come from one screen-share session, so
// there's nothing to transcode - just concatenate the containers. This is
// why the merged master is kept as .webm rather than .mp4: VP8-in-MP4 has
// poor player support, so producing an MP4 losslessly isn't an option, and
// re-encoding to H.264 (the previous approach) is genuinely CPU-heavy on a
// shared Railway vCPU - that was the actual cause of "processing takes way
// too long", not a fixable inefficiency in a fast path.
//
// The one remaining transcode is trimming a clip to MP4 for download, which
// only runs on-demand when someone actually asks for a clip - a few seconds
// of wait there is expected and tolerated, unlike blocking every single
// shift's finalization.

const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

ffmpeg.setFfmpegPath(ffmpegPath);

function tempPath(ext) {
  return path.join(os.tmpdir(), `wp-bodycam-${crypto.randomBytes(8).toString('hex')}.${ext}`);
}

// Concatenates webm segment files (in order) into one webm via stream copy -
// no re-encoding, so this is fast regardless of how much footage there is.
// Doesn't probe the result for its real duration: ffmpeg-static only bundles
// ffmpeg, not the separate ffprobe binary fluent-ffmpeg's ffprobe() needs,
// so that call was silently failing (returning null) both here and on
// Railway. The caller estimates duration instead, from segment count x
// known segment length - exact enough for display/trim-range purposes
// without a second bundled binary.
function mergeChunksToWebm(chunkPaths) {
  return new Promise((resolve, reject) => {
    const listFile = tempPath('txt');
    const outFile = tempPath('webm');
    fs.writeFileSync(listFile, chunkPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c', 'copy'])
      .on('error', (err) => {
        try { fs.unlinkSync(listFile); } catch (e) {}
        reject(err);
      })
      .on('end', () => {
        try { fs.unlinkSync(listFile); } catch (e) {}
        resolve({ path: outFile });
      })
      .save(outFile);
  });
}

// Trims [startSeconds, endSeconds) out of a recording (webm or mp4 - ffmpeg
// auto-detects) and transcodes to H.264 mp4, since that's the one place a
// broadly-compatible MP4 download is actually needed. "ultrafast" trades
// some file size for speed - this path is already only paid when someone's
// actively waiting on a specific export, so speed matters more here than
// the merge step, not less.
function trimToMp4(inputPath, startSeconds, endSeconds) {
  return new Promise((resolve, reject) => {
    const outFile = tempPath('mp4');
    const duration = Math.max(0.5, endSeconds - startSeconds);
    ffmpeg(inputPath)
      .setStartTime(startSeconds)
      .duration(duration)
      .outputOptions(['-c:v libx264', '-preset ultrafast', '-crf 28', '-movflags +faststart', '-an'])
      .on('error', reject)
      .on('end', () => resolve(outFile))
      .save(outFile);
  });
}

// Splits a video into multiple stream-copied parts if it exceeds
// maxBytesPerPart (Discord's per-file upload cap), so a long shift can post
// as several messages instead of failing outright. Segment duration is
// estimated from the file's actual size-to-duration ratio rather than
// probed - same reasoning as mergeChunksToWebm (no bundled ffprobe binary).
// Returns [inputPath] unchanged if no split was needed.
//
// Stream-copy cuts can only land on existing keyframes, so a requested
// segment length can overshoot its target if this source's keyframes are
// sparser than the size/duration estimate assumes - verified directly
// against a synthetic low-keyframe-rate clip, which produced parts ~40%
// over the requested cap despite the math above looking right. So this
// checks its own output and recursively re-splits anything still over
// maxBytesPerPart, rather than trusting the estimate alone.
async function splitBySize(inputPath, maxBytesPerPart, estimatedDurationSeconds, _depth = 0) {
  const fileSize = fs.statSync(inputPath).size;
  if (fileSize <= maxBytesPerPart || !estimatedDurationSeconds || estimatedDurationSeconds <= 0) {
    return [inputPath];
  }
  if (_depth >= 5) {
    // Keyframes too sparse to cut any finer - hand back the oversized part
    // rather than losing the footage. Shouldn't happen in practice: bodycam
    // chunks restart their recorder (and so get a fresh keyframe) every
    // BODYCAM_SEGMENT_MS, which bounds how far apart keyframes can ever be.
    return [inputPath];
  }

  const bytesPerSecond = fileSize / estimatedDurationSeconds;
  // Margin used to be a flat 15% cut, which wasted a lot of each message's
  // budget: a field test against a realistic chunk-boundary source (see
  // above) showed the actual worst-case keyframe-snap overshoot is bounded
  // to about one bodycam chunk's worth of data (~730KB at this app's
  // 300kbps recording setting), not 15% of the whole part. A fixed 2MB
  // margin comfortably covers that (with room to spare if the recording
  // bitrate is ever raised) while leaving far more of each part's budget
  // usable - fewer, bigger parts per shift instead of splitting early.
  const SPLIT_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024;
  const segmentSeconds = Math.max(5, Math.floor((maxBytesPerPart - SPLIT_SAFETY_MARGIN_BYTES) / bytesPerSecond));
  const base = tempPath('webm').replace(/\.webm$/, '');
  const outPattern = `${base}-%03d.webm`;

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-c', 'copy', '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1'])
      .on('error', reject)
      .on('end', resolve)
      .save(outPattern);
  });

  const dir = path.dirname(base);
  const prefix = path.basename(base) + '-';
  const rawParts = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.webm'))
    .sort()
    .map(f => path.join(dir, f));

  if (rawParts.length === 0) return [inputPath];
  if (rawParts.length === 1) {
    // Couldn't cut anywhere below fileSize (e.g. one keyframe spans the
    // whole clip) - discard the pointless re-mux and hand back the original.
    try { fs.unlinkSync(rawParts[0]); } catch (e) {}
    return [inputPath];
  }

  const finalParts = [];
  for (const part of rawParts) {
    const partSize = fs.statSync(part).size;
    if (partSize <= maxBytesPerPart) {
      finalParts.push(part);
      continue;
    }
    const partDuration = partSize / bytesPerSecond;
    const subParts = await splitBySize(part, maxBytesPerPart, partDuration, _depth + 1);
    if (subParts.length > 1) { try { fs.unlinkSync(part); } catch (e) {} }
    finalParts.push(...subParts);
  }
  return finalParts;
}

// Downloads a URL (following redirects) straight to a local file - shared by
// both the website (server.js) and the bot (bodycamTrim.js) to pull a clip's
// current Discord attachment URL back down before trimming it, since ffmpeg
// needs a local file to read from.
function downloadToFile(fileUrl, destPath, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    https.get(fileUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        return downloadToFile(response.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      }
      const out = fs.createWriteStream(destPath);
      response.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = { mergeChunksToWebm, trimToMp4, splitBySize, downloadToFile, tempPath };
