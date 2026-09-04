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

module.exports = { mergeChunksToWebm, trimToMp4, tempPath };
