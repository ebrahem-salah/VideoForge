/**
 * VideoForge - نسخة FFmpeg فقط (بدون Puppeteer)
 *
 * التثبيت:
 *   npm uninstall puppeteer
 *   npm install express multer cors @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe
 *
 * نفس الـ endpoint: POST /generate-video  (images / audio / intro / outro)
 * جديد: GET /status/:jobId  لمتابعة التقدم ورابط التحميل
 */
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
let ffprobePath = null;
try { ffprobePath = require('@ffprobe-installer/ffprobe').path; } catch (_) { /* نستخدم ffmpeg كبديل */ }

// ───────────── الإعدادات ─────────────
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_JOBS || 1); // عدد الفيديوهات اللي تترندر مع بعض
const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;
const FIRST_IMAGE_SEC = 15;       // الصورة الأولى تاخد 15 ثانية دايمًا
const MIN_OTHER_IMAGE_SEC = 2;    // أقل مدة للصور الباقية (حماية لو الصوت قصير)
const XFADE_SEC = 1.0;            // مدة الانتقال بين الصور
const MAX_FILE_MB = 100;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const PUBLIC_DIR = path.join(__dirname, 'public');
[UPLOADS_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ───────────── Express + رفع الملفات ─────────────
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.static(PUBLIC_DIR));
app.use('/output', express.static(OUTPUT_DIR)); // ملاحظة: /uploads لم يعد متاحاً للعامة

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SAFE_EXT = /^\.(jpe?g|png|webp|mp3|wav|m4a|aac|ogg|opus|flac)$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname).toLowerCase();
    if (!SAFE_EXT.test(ext)) ext = '';
    cb(null, `${file.fieldname}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'images') {
      return IMAGE_TYPES.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error('الصور لازم تكون JPG أو PNG أو WEBP'));
    }
    if (file.fieldname === 'audio') {
      return file.mimetype.startsWith('audio/')
        ? cb(null, true)
        : cb(new Error('ملف الصوت غير مدعوم'));
    }
    cb(null, false); // intro/outro المرفوعة تتجاهل (بنستخدم الثابتة من public)
  }
});

// ───────────── أدوات مساعدة ─────────────
function run(cmd, args) {
  return new Promise(resolve => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => resolve({ code: -1, out, err: String(e) }));
    p.on('close', code => resolve({ code, out, err }));
  });
}

const hmsToSec = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + parseFloat(s);

/** يرجّع { duration, hasAudio } لأي ملف (بدون تعطيل السيرفر) */
async function probe(file) {
  if (ffprobePath) {
    const r = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    if (r.code === 0) {
      try {
        const j = JSON.parse(r.out);
        const duration = parseFloat(j.format && j.format.duration);
        const hasAudio = (j.streams || []).some(s => s.codec_type === 'audio');
        if (duration > 0) return { duration, hasAudio };
      } catch (_) { /* نكمل للبديل */ }
    }
  }
  const r = await run(ffmpegPath, ['-hide_banner', '-i', file]); // ffmpeg بيرجّع كود خطأ هنا وده طبيعي
  const m = r.err.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!m) throw new Error('تعذّر قراءة مدة الملف: ' + path.basename(file));
  return { duration: hmsToSec(m[1], m[2], m[3]), hasAudio: /Audio:/.test(r.err) };
}

/** توزيع مدة الدرس: الصورة الأولى 15 ثانية، والباقي بالتساوي */
function splitDurations(total, n) {
  if (n === 1) return [total];
  let first = FIRST_IMAGE_SEC;
  // لو الصوت قصير ومش هيكفي الباقي، نقلل الأولى بالقدر الضروري بس
  const maxFirst = total - (n - 1) * MIN_OTHER_IMAGE_SEC;
  if (first > maxFirst) first = maxFirst;
  // لو حتى كده مش كفاية (صور كتير على صوت قصير جدًا) نوزع بالتساوي
  if (first < MIN_OTHER_IMAGE_SEC) return Array(n).fill(total / n);
  const rest = (total - first) / (n - 1);
  return [first, ...Array(n - 1).fill(rest)];
}

// ───────────── بناء أمر FFmpeg ─────────────
function buildFfmpegArgs({ introPath, intro, images, audioPath, audioSec, outroPath, outro, outputPath }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  const filters = [];
  const segments = []; // [{v, a}] بالترتيب
  let idx = 0;

  const normVideo = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},format=yuv420p`;
  const normAudio = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';

  // مقدمة / خاتمة (فيديو + صوت متزامنين بنفس المدة بالظبط)
  const addClip = (file, info, tag) => {
    const i = idx++;
    args.push('-i', file);
    const d = info.duration.toFixed(3);
    filters.push(`[${i}:v]${normVideo},tpad=stop_mode=clone:stop_duration=2,trim=duration=${d},setpts=PTS-STARTPTS[v_${tag}]`);
    if (info.hasAudio) {
      filters.push(`[${i}:a]${normAudio},apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a_${tag}]`);
    } else {
      filters.push(`anullsrc=r=44100:cl=stereo,${normAudio},atrim=duration=${d},asetpts=PTS-STARTPTS[a_${tag}]`);
    }
    segments.push({ v: `v_${tag}`, a: `a_${tag}` });
  };

  if (introPath) addClip(introPath, intro, 'intro');

  // ── الدرس: صور + Ken Burns + انتقال fade ──
  const n = images.length;
  const d = splitDurations(audioSec, n);
  const T = n > 1 ? Math.min(XFADE_SEC, Math.min(...d) / 2) : 0;
  const imgStart = idx;

  images.forEach((img, i) => {
    args.push('-i', img.path);
    idx++;
    const len = d[i] + (i < n - 1 ? T : 0); // كل صورة تمتد قدر الانتقال عشان المجموع = مدة الصوت
    const frames = Math.max(2, Math.round(len * FPS));
    const zoom = i % 2 === 0 ? `1+0.15*on/${frames}` : `1.15-0.15*on/${frames}`; // زوم إن ثم زوم أوت بالتبادل
    filters.push(
      `[${imgStart + i}:v]scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,setsar=1,` +
      `zoompan=z='${zoom}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},format=yuv420p[s${i}]`
    );
  });

  if (n === 1) {
    filters.push('[s0]null[vl]');
  } else {
    let cur = 's0';
    let offset = 0;
    for (let i = 1; i < n; i++) {
      offset += d[i - 1];
      const out = i === n - 1 ? 'vl' : `x${i}`;
      filters.push(`[${cur}][s${i}]xfade=transition=fade:duration=${T.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`);
      cur = out;
    }
  }
  const A = audioSec.toFixed(3);
  filters.push(`[vl]tpad=stop_mode=clone:stop_duration=1,trim=duration=${A},setpts=PTS-STARTPTS[v_lesson]`);

  const audioIdx = idx++;
  args.push('-i', audioPath);
  filters.push(`[${audioIdx}:a]${normAudio},apad,atrim=duration=${A},asetpts=PTS-STARTPTS[a_lesson]`);
  segments.push({ v: 'v_lesson', a: 'a_lesson' });

  if (outroPath) addClip(outroPath, outro, 'outro');

  // ── دمج الأجزاء ──
  const concatIn = segments.map(s => `[${s.v}][${s.a}]`).join('');
  filters.push(`${concatIn}concat=n=${segments.length}:v=1:a=1[vout][aout]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath
  );
  return args;
}

/** يشغّل FFmpeg ويحدّث النسبة المئوية. يرفض الـ Promise لو الكود != 0 */
function runFfmpeg(args, totalSec, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let errTail = '';
    let buf = '';

    p.stdout.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/); // الاتنين بالميكروثانية
        if (m) onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6 / totalSec) * 100)));
      }
    });
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-4000); }); // لازم نقرأه وإلا FFmpeg يتعلق
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error('FFmpeg فشل (code ' + code + '): ' + errTail.trim()))));
  });
}

// ───────────── طابور المهام ─────────────
const jobs = new Map();
const queue = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT_JOBS && queue.length) {
    const job = queue.shift();
    running++;
    processJob(job).finally(() => { running--; pump(); });
  }
}

async function processJob(job) {
  const outputFilename = `video_${job.id}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  try {
    job.status = 'processing';

    const fixedIntro = path.join(PUBLIC_DIR, 'intro.mp4');
    const fixedOutro = path.join(PUBLIC_DIR, 'outro.mp4');
    const introPath = fs.existsSync(fixedIntro) ? fixedIntro : null;
    const outroPath = fs.existsSync(fixedOutro) ? fixedOutro : null;
    if (!introPath) console.log('⚠️ intro.mp4 غير موجود في public');
    if (!outroPath) console.log('⚠️ outro.mp4 غير موجود في public');

    const [intro, outro, audio] = await Promise.all([
      introPath ? probe(introPath) : null,
      outroPath ? probe(outroPath) : null,
      probe(job.audioPath)
    ]);
    const audioSec = audio.duration;
    const totalSec = (intro ? intro.duration : 0) + audioSec + (outro ? outro.duration : 0);
    console.log(`[${job.id}] مقدمة ${intro ? intro.duration.toFixed(1) : 0}s | درس ${audioSec.toFixed(1)}s | خاتمة ${outro ? outro.duration.toFixed(1) : 0}s | ${job.images.length} صورة`);

    const args = buildFfmpegArgs({
      introPath, intro, images: job.images, audioPath: job.audioPath, audioSec, outroPath, outro, outputPath
    });

    let lastLogged = -10;
    await runFfmpeg(args, totalSec, pct => {
      job.progress = pct;
      if (pct - lastLogged >= 10) { lastLogged = pct; console.log(`[${job.id}] ⏳ ${pct}%`); }
    });

    job.progress = 100;
    job.status = 'done';
    job.downloadUrl = `/output/${outputFilename}`;
    console.log(`[${job.id}] ✅ تم: ${outputFilename}`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    console.error(`[${job.id}] ❌`, err.message);
    fs.promises.unlink(outputPath).catch(() => {});
  } finally {
    job.finishedAt = Date.now();
    // نمسح الملفات المرفوعة في كل الأحوال
    [...job.images.map(i => i.path), job.audioPath].forEach(f => fs.promises.unlink(f).catch(() => {}));
  }
}

// تنظيف سجل المهام القديمة (ساعة)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
}, 10 * 60 * 1000).unref();

// ───────────── الـ Endpoints ─────────────
app.post('/generate-video', upload.fields([
  { name: 'images', maxCount: 15 },
  { name: 'audio', maxCount: 1 },
  { name: 'intro', maxCount: 1 },
  { name: 'outro', maxCount: 1 }
]), (req, res) => {
  const files = req.files || {};
  const images = files['images'] ? [...files['images']] : [];
  const audio = files['audio'] && files['audio'][0];

  if (!images.length || !audio) {
    [...images, audio].filter(Boolean).forEach(f => fs.promises.unlink(f.path).catch(() => {}));
    return res.status(400).json({ error: 'الصور والصوت للدرس مطلوبة!' });
  }

  // ترتيب الصور حسب الرقم في اسم الملف
  const num = f => parseInt((f.originalname.match(/\d+/) || [0])[0], 10);
  images.sort((a, b) => num(a) - num(b));
  images.forEach((img, i) => console.log(`صورة ${i + 1}: ${img.originalname}`));

  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    status: 'queued',
    progress: 0,
    downloadUrl: null,
    error: null,
    images,
    audioPath: audio.path
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();

  res.status(202).json({
    message: 'تم استلام الطلب وجاري تصميم الفيديو في الخلفية.',
    jobId: job.id,
    statusUrl: `/status/${job.id}`,
    downloadUrl: null
  });
});

app.get('/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'المهمة غير موجودة' });
  res.json({ status: job.status, progress: job.progress, downloadUrl: job.downloadUrl, error: job.error });
});

// أخطاء multer (حجم/نوع الملف)
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(PORT, () => {
  console.log(`VideoForge Server is running at http://localhost:${PORT}`);
});
