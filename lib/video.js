// ffmpeg helpers for the bodycam pipeline: merging uploaded recorder chunks
// (webm, VP8/9+Opus from the browser's MediaRecorder) into one downloadable
// mp4, and trimming a clip out of a finished recording.

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

// Concatenates webm chunk buffers (in order) into a single mp4 file on disk,
// returning its path and duration. Caller is responsible for cleaning up the
// returned file and any input files.
function mergeChunksToMp4(chunkPaths) {
  return new Promise((resolve, reject) => {
    const listFile = tempPath('txt');
    const outFile = tempPath('mp4');
    fs.writeFileSync(listFile, chunkPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 28', '-movflags +faststart', '-an'])
      .on('error', (err) => {
        try { fs.unlinkSync(listFile); } catch (e) {}
        reject(err);
      })
      .on('end', () => {
        try { fs.unlinkSync(listFile); } catch (e) {}
        ffmpeg.ffprobe(outFile, (err, data) => {
          const duration = (!err && data?.format?.duration) ? Math.round(data.format.duration) : null;
          resolve({ path: outFile, durationSeconds: duration });
        });
      })
      .save(outFile);
  });
}

// Trims [startSeconds, endSeconds) out of an mp4 file already on disk.
function trimMp4(inputPath, startSeconds, endSeconds) {
  return new Promise((resolve, reject) => {
    const outFile = tempPath('mp4');
    const duration = Math.max(0.5, endSeconds - startSeconds);
    ffmpeg(inputPath)
      .setStartTime(startSeconds)
      .duration(duration)
      .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 28', '-movflags +faststart', '-an'])
      .on('error', reject)
      .on('end', () => resolve(outFile))
      .save(outFile);
  });
}

module.exports = { mergeChunksToMp4, trimMp4, tempPath };
