// ffmpeg helpers for the bodycam pipeline.
//
// Merging uses stream copy (-c copy), not a re-encode: every chunk is
// already VP8/webm from the browser's MediaRecorder, at the same
// resolution/codec since they all come from one screen-share session, so
// there's nothing to transcode - just concatenate the containers. The merged
// master stays .webm at this stage; converting the whole shift to MP4 (so it
// plays inline in Discord's own clients, not just embeds) happens once as a
// single "ultrafast" H.264 pass afterward (see trimToMp4, reused for a
// full-file convert) rather than transcoding each chunk individually.

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
// broadly-compatible MP4 download is actually needed. CRF (quality-driven,
// not size-driven) is fine here: clips exported through this path are short
// on-demand exports, so even "ultrafast" trading compression efficiency for
// speed only costs a few extra MB on a short clip.
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

// Bodycam recording constants mirrored from BODYCAM_MAX_WIDTH/HEIGHT and
// BODYCAM_FRAMERATE in employee-dashboard.html - must match, same as
// BODYCAM_SEGMENT_MS in server.js. Used only to label the overlay text
// below; the actual bitrate label comes from convertToMp4's own measured
// source bitrate instead of a hardcoded value, since that's the number
// that's actually true of any given recording.
const BODYCAM_WIDTH = 1280;
const BODYCAM_HEIGHT = 720;
const BODYCAM_FRAMERATE = 8;

// Font bundled with the repo (Apache 2.0, see assets/LICENSE-Roboto.txt)
// rather than relying on a system font: ffmpeg's drawtext filter needs an
// actual font file, and there's no guarantee Railway's container (or any
// other host this ever runs on) has one installed - verified this matters
// by testing without a bundled font first. Path is normalized to forward
// slashes since backslashes are themselves an escape character in ffmpeg's
// filter syntax, which would otherwise corrupt a Windows-style path.
const OVERLAY_FONT_PATH = path.join(__dirname, 'assets', 'Roboto-Regular.ttf').replace(/\\/g, '/');

// Builds the drawtext filter that burns exact time/date/timezone/FPS/quality
// into the top-left corner of the whole shift, matching a real bodycam's
// timestamp overlay. startEpochSeconds is the recording's real start time
// (bcSession.started_at from bot.db, converted to unix seconds) - the
// overlay computes each frame's actual wall-clock time from that plus the
// frame's own position in the video, so the clock visibly advances through
// playback instead of showing one frozen timestamp.
//
// The date/time value is split into FOUR separate %{pts:gmtime:...} blocks
// (year-month-day, hour, minute, second) joined by literal text instead of
// one combined "%Y-%m-%d %H:%M:%S" format string - verified directly that a
// literal ':' *inside* a single expansion's format string breaks silently
// (no error, but the text vanishes entirely), because drawtext's own ':'-
// separated option parsing consumes it before gmtime ever sees the format.
// Splitting at each colon and re-inserting it as escaped literal text
// between separate expansions is the actual working form. gmtime (not
// localtime) is used deliberately so the "UTC" label is always correct
// regardless of the host machine/container's own timezone configuration.
function buildOverlayFilter(startEpochSeconds, bitrateKbps) {
  const gmt = (fmt) => `%{pts\\:gmtime\\:${startEpochSeconds}\\:${fmt}}`;
  const timeText = `${gmt('%Y-%m-%d')} ${gmt('%H')}\\:${gmt('%M')}\\:${gmt('%S')} UTC  ${BODYCAM_WIDTH}x${BODYCAM_HEIGHT} @ ${BODYCAM_FRAMERATE}fps  ${bitrateKbps}kbps`;
  return `drawtext=fontfile='${OVERLAY_FONT_PATH}':text='${timeText}':x=10:y=10:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`;
}

// Converts a whole merged shift to H.264 mp4 (so it plays inline in
// Discord's own clients instead of just downloading), targeting a bitrate
// measured from the source file itself rather than a fixed CRF. CRF is
// quality-driven, not size-driven - verified directly: at "ultrafast" (the
// only realistic preset for a 10-60+ minute clip) + CRF 28, a 65MB/30min
// webm source came back as a 327MB mp4, nearly 5x larger, because ultrafast
// sacrifices compression efficiency for speed and CRF doesn't care how big
// the result gets in exchange. That blew a 30-minute shift up from ~5
// Discord messages to 21 and from ~38s of processing to ~127s - the exact
// regression this feature can't afford. Targeting the source's own
// bitrate (with a little headroom via maxrate/bufsize) keeps the mp4
// comparable in size to the webm it replaces, at the same "ultrafast" speed.
// Also burns in the top-left time/date/timezone/FPS/quality overlay - see
// buildOverlayFilter above - since this is the one ffmpeg pass the whole
// shift already goes through, adding a video filter here is free compared
// to a second full pass.
function convertToMp4(inputPath, durationSeconds, startEpochSeconds) {
  return new Promise((resolve, reject) => {
    const outFile = tempPath('mp4');
    const fileSize = fs.statSync(inputPath).size;
    const sourceBitrateKbps = Math.max(150, Math.round((fileSize * 8) / durationSeconds / 1000));
    const outputOptions = [
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', `${sourceBitrateKbps}k`,
      '-maxrate', `${Math.round(sourceBitrateKbps * 1.3)}k`,
      '-bufsize', `${sourceBitrateKbps * 2}k`,
      '-movflags', '+faststart',
      '-an'
    ];
    if (startEpochSeconds) {
      outputOptions.push('-vf', buildOverlayFilter(startEpochSeconds, sourceBitrateKbps));
    }
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
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
  // Works for whatever container the input actually is (webm or mp4) rather
  // than assuming webm - the split step runs on the mp4 master now, not the
  // raw webm merge.
  const ext = path.extname(inputPath).slice(1) || 'webm';
  const base = tempPath(ext).replace(new RegExp(`\\.${ext}$`), '');
  const outPattern = `${base}-%03d.${ext}`;

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
    .filter(f => f.startsWith(prefix) && f.endsWith(`.${ext}`))
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

module.exports = { mergeChunksToWebm, trimToMp4, convertToMp4, splitBySize, downloadToFile, tempPath };
