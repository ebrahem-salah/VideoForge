const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const puppeteer = require('puppeteer');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const app = express();
const port = 3000;

// مجلدات ضرورية
const PUBLIC_DIR = path.join(__dirname, 'public');
const LIBRARY_DIR = path.join(PUBLIC_DIR, 'library');
const OUTPUT_DIR = path.join(__dirname, 'output');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

[PUBLIC_DIR, LIBRARY_DIR, OUTPUT_DIR, UPLOADS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(express.static(PUBLIC_DIR));
app.use('/output', express.static(OUTPUT_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// القاموس الذكي الأساسي للكلمات (يمكنك إضافة أي كلمات جديدة هنا لاحقاً)
const smartDictionary = {
  "apple": { ar: "تفاحة", phonics: "أَبِل" },
  "ant": { ar: "نملة", phonics: "آنت" },
  "alligator": { ar: "تمساح", phonics: "أليجيتور" },
  "airplane": { ar: "طائرة", phonics: "إيربلين" },
  "arrow": { ar: "سهم", phonics: "آرو" },
  "arm": { ar: "ذراع", phonics: "أَرْم" },
  "bear": { ar: "دب", phonics: "بير" },
  "boy": { ar: "ولد", phonics: "بوي" },
  "ball": { ar: "كرة", phonics: "بول" },
  "cat": { ar: "قطة", phonics: "كات" },
  "car": { ar: "سيارة", phonics: "كار" }
};

app.post('/generate-video-auto', upload.fields([{ name: 'audio', maxCount: 1 }]), async (req, res) => {
  try {
    console.log('\n--- بدأ طلب فيديو الأتمتة الذكي ---');
    if (!req.files['audio']) return res.status(400).json({ error: 'الصوت مطلوب!' });

    const audioPath = req.files['audio'][0].path;
    const letterText = req.body.letter_text || '';
    const wordsListRaw = req.body.words_list || '';

    // تحليل الكلمات
    const words = wordsListRaw.split(',').map(w => w.trim()).filter(w => w);
    console.log('الكلمات المطلوبة:', words);

    // البحث في المكتبة وجلب الترجمة
    const libraryFiles = fs.readdirSync(LIBRARY_DIR);
    const slides = words.map(word => {
        const lowerWord = word.toLowerCase();
        
        // البحث عن المعنى في القاموس
        const dictEntry = smartDictionary[lowerWord] || { ar: "كلمة", phonics: "نطق" };
        
        // البحث عن صورة الكلمة في مكتبة الصور (library)
        const imgFile = libraryFiles.find(f => f.toLowerCase().startsWith(lowerWord + '.') || f.toLowerCase() === lowerWord + '.png');
        
        return {
            en: word,
            ar: dictEntry.ar,
            phonics: dictEntry.phonics,
            // إذا لم يجد صورة، نضع صورة فارغة مؤقتاً لتجنب توقف السيرفر
            url: imgFile ? `http://localhost:${port}/library/${imgFile}` : `http://localhost:${port}/placeholder.png`
        };
    });

    const outputFilename = `video_auto_${Date.now()}.mp4`;
    const finalPath = path.join(OUTPUT_DIR, outputFilename);
    const tempVideo = path.join(OUTPUT_DIR, `temp_${Date.now()}.mp4`);

    res.json({ message: 'جاري سحب الصور من المكتبة ورسم الفيديو آلياً! راقب الشاشة السوداء.', downloadUrl: `/output/${outputFilename}` });

    (async () => {
      let browser;
      try {
        const audioMetadata = spawnSync(ffmpegPath, ['-i', audioPath]).stderr.toString();
        let audioDurationSec = 10; 
        const durationMatch = audioMetadata.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (durationMatch) {
           audioDurationSec = parseInt(durationMatch[1])*3600 + parseInt(durationMatch[2])*60 + parseFloat(durationMatch[3]);
        }
        console.log(`طول الصوت: ${audioDurationSec} ثانية. شرائح الكلمات: ${slides.length}`);

        const FPS = 15;
        const totalFrames = Math.round(audioDurationSec * FPS);
        const letterFrames = letterText ? Math.min(10 * FPS, totalFrames) : 0;
        const framesPerSlide = slides.length > 0 ? Math.floor((totalFrames - letterFrames) / slides.length) : 0;

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        const htmlContent = `
          <!DOCTYPE html>
          <html lang="ar" dir="rtl">
          <head>
            <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@700;900&family=Nunito:wght@900&display=swap" rel="stylesheet">
            <style>
              body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: linear-gradient(135deg, #0fbcad, #0067b8); font-family: 'Cairo', sans-serif; color: white; }
              .header { position: absolute; top: 30px; left: 40px; right: 40px; display: flex; justify-content: space-between; align-items: center; z-index: 100; }
              .header-pill { background: rgba(255,255,255,0.2); padding: 8px 25px; border-radius: 30px; font-weight: bold; font-size: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
              .logo-box { background: white; color: #0067b8; padding: 5px 20px; border-radius: 30px; font-weight: 900; font-size: 22px; display: flex; align-items: center; gap: 10px; }
              
              #letter-screen { position: absolute; inset: 0; display: flex; justify-content: center; align-items: center; z-index: 50; background: linear-gradient(135deg, #0fbcad, #0067b8); }
              .creative-letter { font-family: 'Nunito', sans-serif; font-size: 350px; font-weight: 900; background: linear-gradient(to right, #ff007f, #ffcc00); -webkit-background-clip: text; color: transparent; text-shadow: 5px 5px 20px rgba(0,0,0,0.3); animation: dropBounce 1.5s cubic-bezier(0.28, 0.84, 0.42, 1) forwards; }
              
              #lesson-screen { position: absolute; inset: 0; display: none; padding-top: 80px; align-items: center; justify-content: space-around; z-index: 40; }
              .text-side { flex: 1; padding-right: 80px; display: flex; flex-direction: column; justify-content: center; }
              .image-side { flex: 1; display: flex; justify-content: center; align-items: center; }
              .word-pill { background: rgba(255,255,255,0.2); padding: 5px 20px; border-radius: 20px; font-size: 24px; align-self: flex-start; margin-bottom: -10px; }
              .en-word { font-family: 'Nunito', sans-serif; font-size: 130px; font-weight: 900; margin: 0; letter-spacing: 3px; text-shadow: 4px 4px 0 rgba(0,0,0,0.2); }
              .phonics-box { background: rgba(0,0,0,0.2); border: 2px solid rgba(255,255,255,0.3); padding: 10px 25px; border-radius: 15px; font-size: 26px; margin-bottom: 20px; display: inline-block; align-self: flex-start; }
              .ar-meaning { font-size: 45px; font-weight: bold; margin-bottom: 20px; text-shadow: 2px 2px 5px rgba(0,0,0,0.3); }
              .listen-pill { background: #004d40; padding: 10px 25px; border-radius: 20px; font-size: 24px; font-weight: bold; align-self: flex-start; border: 2px solid #00bfa5; }

              .image-box { width: 450px; height: 450px; background: white; border-radius: 40px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); display: flex; justify-content: center; align-items: center; padding: 20px; animation: float 6s ease-in-out infinite; }
              .image-box img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 20px; }

              @keyframes dropBounce { 0% { transform: translateY(-800px); opacity: 0; } 50% { transform: translateY(0px); opacity: 1; } 65% { transform: translateY(-100px); } 80% { transform: translateY(0px); } 90% { transform: translateY(-20px); } 100% { transform: translateY(0px); opacity: 1; } }
              @keyframes float { 0% { transform: translateY(0); } 50% { transform: translateY(-15px); } 100% { transform: translateY(0); } }
              @keyframes popIn { 0% { transform: scale(0.5); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
            </style>
          </head>
          <body>
            <div class="header">
              <div class="header-pill" id="top-pill">Official Lesson</div>
              <div class="logo-box">📘 تعلم مع يونس</div>
            </div>

            <div id="letter-screen" style="${letterText ? 'display:flex;' : 'display:none;'}">
              <div class="creative-letter">${letterText}</div>
            </div>

            <div id="lesson-screen">
              <div class="text-side">
                <div class="word-pill" id="ui-letter">Letter</div>
                <h1 class="en-word" id="ui-en">Word</h1>
                <div class="phonics-box">النطق: <span id="ui-phonics" style="color: #ffcc00;">نطق</span></div>
                <div class="ar-meaning">المعنى: <span id="ui-ar" style="border-bottom: 4px solid white;">عربي</span></div>
                <div class="listen-pill">🔊 استمع وكرر بتركيز</div>
              </div>
              <div class="image-side">
                <div class="image-box">
                  <img id="ui-img" src="" onerror="this.style.display='none'" />
                </div>
              </div>
            </div>
          </body>
          </html>
        `;
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const ffmpegRender = spawn(ffmpegPath, [
          '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-r', String(FPS),
          '-i', '-', '-i', audioPath,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-shortest', tempVideo
        ]);

        let frameCount = 0;
        const captureFrame = async () => {
          const buffer = await page.screenshot({ type: 'jpeg', quality: 90 });
          ffmpegRender.stdin.write(buffer);
          frameCount++;
          if (frameCount % 15 === 0) console.log(`⏳ جاري الإخراج: ${Math.floor((frameCount/totalFrames)*100)}%`);
        };

        if (letterText && letterFrames > 0) {
          for (let i = 0; i < letterFrames; i++) await captureFrame();
        }

        await page.evaluate(() => {
          document.getElementById('letter-screen').style.display = 'none';
          document.getElementById('lesson-screen').style.display = 'flex';
        });

        const slideData = JSON.stringify(slides);
        for (let i = 0; i < slides.length; i++) {
          await page.evaluate((dataStr, index) => {
            const data = JSON.parse(dataStr);
            document.getElementById('ui-letter').innerText = 'Letter ' + data[index].en.charAt(0).toUpperCase();
            document.getElementById('ui-en').innerText = data[index].en;
            document.getElementById('ui-ar').innerText = data[index].ar;
            document.getElementById('ui-phonics').innerText = data[index].phonics;
            const img = document.getElementById('ui-img');
            img.src = data[index].url;
            img.style.display = 'block';

            const enEl = document.getElementById('ui-en');
            enEl.style.animation = 'none'; img.style.animation = 'none';
            void enEl.offsetWidth; 
            enEl.style.animation = 'popIn 0.5s ease-out'; img.style.animation = 'popIn 0.6s ease-out';
          }, slideData, i);

          await new Promise(r => setTimeout(r, 100)); 
          for (let f = 0; f < framesPerSlide; f++) await captureFrame();
        }

        ffmpegRender.stdin.end();

        await new Promise((resolve, reject) => {
          ffmpegRender.on('close', code => code === 0 ? resolve() : reject(new Error('فشل دمج الفيديو')));
        });

        const introPath = path.join(PUBLIC_DIR, 'intro.mp4');
        const outroPath = path.join(PUBLIC_DIR, 'outro.mp4');
        
        let filterStr = ''; let inputArgs = []; let mapStr = []; let index = 0;
        if (fs.existsSync(introPath)) { inputArgs.push('-i', introPath); filterStr += `[${index}:v:0][${index}:a:0]`; index++; }
        inputArgs.push('-i', tempVideo); filterStr += `[${index}:v:0][${index}:a:0]`; index++;
        if (fs.existsSync(outroPath)) { inputArgs.push('-i', outroPath); filterStr += `[${index}:v:0][${index}:a:0]`; index++; }
        filterStr += `concat=n=${index}:v=1:a=1[outv][outa]`;

        console.log('⏳ جاري تركيب المقدمة والنهاية...');
        spawnSync(ffmpegPath, [
            '-y', ...inputArgs, '-filter_complex', filterStr,
            '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', finalPath
        ]);

        console.log(`✅ انتهى بنجاح! الملف: ${outputFilename}`);
        await browser.close();
        fs.unlinkSync(tempVideo);

      } catch (err) {
        console.error('❌ خطأ:', err.message);
        if (browser) await browser.close();
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`Server is running at http://localhost:${port}`));
