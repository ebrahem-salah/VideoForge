const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const app = express();
const port = 3000;

const cors = require('cors');
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + Date.now() + ext);
  }
});
const upload = multer({ storage: storage });

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

// أبقينا الحقول تحسباً لو أرسلها المتصفح حتى لا ينهار، لكننا سنتجاهلها
app.post('/generate-video', upload.fields([
  { name: 'images', maxCount: 15 },
  { name: 'audio', maxCount: 1 },
  { name: 'intro', maxCount: 1 },
  { name: 'outro', maxCount: 1 }
]), async (req, res) => {
  try {
    console.log('\n--- بدأ طلب فيديو جديد (بمقدمة ونهاية ثابتة) ---');
    if (!req.files['images'] || !req.files['audio']) {
      return res.status(400).json({ error: 'الصور والصوت للدرس مطلوبة!' });
    }

    const images = req.files['images'];
    
    // ترتيب الصور
    images.sort((a, b) => {
      const numA = parseInt((a.originalname.match(/\d+/) || [0])[0]);
      const numB = parseInt((b.originalname.match(/\d+/) || [0])[0]);
      return numA - numB;
    });
    console.log('الترتيب النهائي للصور:');
    images.forEach((img, idx) => console.log(`صورة ${idx + 1}: ${img.originalname}`));

    const audioPath = req.files['audio'][0].path;
    
    // سحب المقدمة والنهاية الثابتة من مجلد public
    const fixedIntroPath = path.join(__dirname, 'public', 'intro.mp4');
    const fixedOutroPath = path.join(__dirname, 'public', 'outro.mp4');
    
    const introPath = fs.existsSync(fixedIntroPath) ? fixedIntroPath : null;
    const outroPath = fs.existsSync(fixedOutroPath) ? fixedOutroPath : null;

    if (!introPath) console.log('⚠️ تحذير: لم يتم العثور على intro.mp4 في مجلد public');
    if (!outroPath) console.log('⚠️ تحذير: لم يتم العثور على outro.mp4 في مجلد public');
    
    const outputFilename = `video_${Date.now()}.mp4`;
    const outputPath = path.join(__dirname, 'output', outputFilename);

    res.json({ message: 'جاري الآن تصميم الفيديو بالكامل في الخلفية! راقب الشاشة السوداء.', downloadUrl: null });

    (async () => {
      try {
        let introDurationMs = 0;
        let introDurationSec = 0;
        let hasIntroAudio = false;
        let introUrl = null;
        
        if (introPath) {
          introUrl = `http://localhost:${port}/intro.mp4`; // الرابط الثابت
          const introMetadata = spawnSync(ffmpegPath, ['-i', introPath]).stderr.toString();
          hasIntroAudio = introMetadata.includes('Audio:');
          const durationMatch = introMetadata.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
          if (durationMatch) {
             introDurationSec = parseInt(durationMatch[1])*3600 + parseInt(durationMatch[2])*60 + parseFloat(durationMatch[3]);
          } else {
             introDurationSec = 3; 
          }
          introDurationMs = Math.floor(introDurationSec * 1000);
          console.log(`طول المقدمة الثابتة: ${introDurationSec.toFixed(2)}s`);
        }

        const audioMetadata = spawnSync(ffmpegPath, ['-i', audioPath]).stderr.toString();
        let audioDurationSec = 5; 
        const audioDurationMatch = audioMetadata.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (audioDurationMatch) {
           audioDurationSec = parseInt(audioDurationMatch[1])*3600 + parseInt(audioDurationMatch[2])*60 + parseFloat(audioDurationMatch[3]);
        }
        console.log(`طول صوت الدرس: ${audioDurationSec.toFixed(2)}s. عدد الصور: ${images.length}`);

        let outroDurationMs = 0;
        let outroDurationSec = 0;
        let hasOutroAudio = false;
        let outroUrl = null;
        
        if (outroPath) {
          outroUrl = `http://localhost:${port}/outro.mp4`; // الرابط الثابت
          const outroMetadata = spawnSync(ffmpegPath, ['-i', outroPath]).stderr.toString();
          hasOutroAudio = outroMetadata.includes('Audio:');
          const durationMatch = outroMetadata.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
          if (durationMatch) {
             outroDurationSec = parseInt(durationMatch[1])*3600 + parseInt(durationMatch[2])*60 + parseFloat(durationMatch[3]);
          } else {
             outroDurationSec = 3; 
          }
          outroDurationMs = Math.floor(outroDurationSec * 1000);
          console.log(`طول الخاتمة الثابتة: ${outroDurationSec.toFixed(2)}s`);
        }

        const imageUrls = images.map(img => `http://localhost:${port}/uploads/${path.basename(img.path)}`);

        const tempHtmlFilename = `temp_render_${Date.now()}.html`;
        const htmlPath = path.join(__dirname, 'public', tempHtmlFilename);
        const pageUrl = `http://localhost:${port}/${tempHtmlFilename}`;
        
        const imageTags = imageUrls.map((src, i) => 
           `<img id="img-${i}" class="slideshow-img" src="${src}" style="opacity: ${i === 0 ? 1 : 0};" />`
        ).join('\n');

        const htmlContent = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body, html { margin: 0; padding: 0; width: 1280px; height: 720px; overflow: hidden; background-color: #000; }
              #intro-screen, #lesson-screen, #outro-screen { width: 100%; height: 100%; position: absolute; top: 0; left: 0; display: flex; justify-content: center; align-items: center; }
              #lesson-screen { display: none; background-color: #ffffff; position: relative; overflow: hidden; }
              video { width: 100%; height: 100%; object-fit: cover; }
              @keyframes kenburns {
                  0% { transform: scale(1.0) translate(0, 0); }
                  100% { transform: scale(1.15) translate(-15px, 10px); }
              }
              .slideshow-img {
                  position: absolute;
                  top: 0; left: 0;
                  width: 100%; height: 100%;
                  object-fit: cover;
                  transition: opacity 1.2s ease-in-out;
                  animation: kenburns 20s infinite alternate ease-in-out;
              }
            </style>
          </head>
          <body>
            ${introUrl ? `<div id="intro-screen"><video id="intro-vid" src="${introUrl}" preload="auto" muted></video></div>` : ''}
            <div id="lesson-screen" style="${introUrl ? 'display: none;' : 'display: flex;'}">
              ${imageTags}
            </div>
            ${outroUrl ? `<div id="outro-screen" style="display: none;"><video id="outro-vid" src="${outroUrl}" preload="auto" muted></video></div>` : ''}
            
            <script>
              window.renderComplete = false;
              async function startRecording() {
                const FPS = 15; 
                const hasIntro = ${!!introUrl};
                const hasOutro = ${!!outroUrl};
                
                const introFrames = Math.floor(${introDurationSec} * FPS);
                const lessonFrames = Math.floor(${audioDurationSec} * FPS);
                const outroFrames = Math.floor(${outroDurationSec} * FPS);
                
                const numImages = ${imageUrls.length};
                const firstImageFrames = Math.min(15 * FPS, lessonFrames);
                let framesPerRemainingImage = 0;
                if (numImages > 1) {
                    const remainingFrames = Math.max(0, lessonFrames - firstImageFrames);
                    framesPerRemainingImage = remainingFrames / (numImages - 1);
                }
                
                let currentFrame = 0;
                let currentImgIndex = 0;
                let phase = hasIntro ? 'intro' : 'lesson';
                
                const introVid = document.getElementById('intro-vid');
                const introScreen = document.getElementById('intro-screen');
                const lessonScreen = document.getElementById('lesson-screen');
                const outroVid = document.getElementById('outro-vid');
                const outroScreen = document.getElementById('outro-screen');

                window.getNextFrame = async () => {
                  currentFrame++;
                  
                  if (phase === 'intro') {
                    if (currentFrame >= introFrames) {
                       phase = 'lesson';
                       currentFrame = 0; 
                       if(introScreen) introScreen.style.display = 'none';
                       lessonScreen.style.display = 'flex';
                       return true; 
                    }
                    return new Promise(resolve => {
                       introVid.onseeked = () => resolve(true);
                       introVid.currentTime = currentFrame / FPS;
                    });
                  }

                  if (phase === 'lesson') {
                    if (currentFrame >= lessonFrames) {
                      if (hasOutro) {
                          phase = 'outro';
                          currentFrame = 0;
                          lessonScreen.style.display = 'none';
                          if (outroScreen) outroScreen.style.display = 'flex';
                          return true;
                      } else {
                          window.renderComplete = true;
                          return false;
                      }
                    }
                    
                    if (numImages > 1) {
                        let newIndex = 0;
                        if (currentFrame <= firstImageFrames) {
                            newIndex = 0;
                        } else {
                            const passedFrames = currentFrame - firstImageFrames;
                            newIndex = 1 + Math.floor(passedFrames / framesPerRemainingImage);
                        }
                        if (newIndex >= numImages) newIndex = numImages - 1;
                        if (newIndex !== currentImgIndex) {
                            document.getElementById('img-' + currentImgIndex).style.opacity = 0;
                            document.getElementById('img-' + newIndex).style.opacity = 1;
                            currentImgIndex = newIndex;
                        }
                    }
                    return true; 
                  }
                  
                  if (phase === 'outro') {
                    if (currentFrame >= outroFrames) {
                        window.renderComplete = true;
                        return false;
                    }
                    return new Promise(resolve => {
                        outroVid.onseeked = () => resolve(true);
                        outroVid.currentTime = currentFrame / FPS;
                    });
                  }
                };
              }
            </script>
          </body>
          </html>
        `;

        fs.writeFileSync(htmlPath, htmlContent);

        console.log('جاري فتح المتصفح الخفي...');
        const browser = await puppeteer.launch({ 
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--allow-file-access-from-files', 
            '--autoplay-policy=no-user-gesture-required'
          ]
        });
        
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        
        await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        await new Promise(r => setTimeout(r, 1000));
        await page.evaluate(() => startRecording());

        const ffmpegArgs = [
          '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-r', '15', '-i', '-'
        ];

        let filterInputs = '';
        let filterMix = '';
        let inputIndex = 1; 
        let audioSourcesCount = 0;

        if (introPath && hasIntroAudio) {
            ffmpegArgs.push('-i', introPath);
            filterInputs += `[${inputIndex}:a]adelay=0|0[a_intro]; `;
            filterMix += `[a_intro]`;
            inputIndex++;
            audioSourcesCount++;
        }

        ffmpegArgs.push('-i', audioPath);
        filterInputs += `[${inputIndex}:a]adelay=${introDurationMs}|${introDurationMs}[a_lesson]; `;
        filterMix += `[a_lesson]`;
        inputIndex++;
        audioSourcesCount++;

        if (outroPath && hasOutroAudio) {
            ffmpegArgs.push('-i', outroPath);
            const outroDelayMs = introDurationMs + Math.floor(audioDurationSec * 1000);
            filterInputs += `[${inputIndex}:a]adelay=${outroDelayMs}|${outroDelayMs}[a_outro]; `;
            filterMix += `[a_outro]`;
            inputIndex++;
            audioSourcesCount++;
        }

        const filterComplex = `${filterInputs}${filterMix}amix=inputs=${audioSourcesCount}:duration=longest:dropout_transition=0[aout]`;
        ffmpegArgs.push('-filter_complex', filterComplex);
        ffmpegArgs.push('-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-shortest', outputPath);

        console.log('بدأ تصوير وتجميع الفيديو...');
        const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
        
        ffmpegProcess.on('close', (code) => {
          if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
          browser.close();
          console.log(`✅ انتهى الفيديو بنجاح تام بنسبة 100%! تجده في مجلد output باسم: ${outputFilename}`);
        });

        let keepRecording = true;
        let frameCount = 0;
        
        const totalFrames = Math.floor((introDurationSec + audioDurationSec + outroDurationSec) * 15);
        
        try {
          while (keepRecording) {
            const frameBuffer = await page.screenshot({ type: 'jpeg', quality: 90 });
            
            if (!ffmpegProcess.stdin.write(frameBuffer)) {
                await new Promise(r => ffmpegProcess.stdin.once('drain', r));
            }
            
            keepRecording = await page.evaluate(() => window.getNextFrame());
            frameCount++;
            
            if (frameCount % 15 === 0) {
               const percent = Math.min(100, Math.round((frameCount / totalFrames) * 100));
               console.log(`⏳ جاري المعالجة: ${percent}% (تم دمج ${frameCount} من ${totalFrames} صورة)`);
            }
          }
        } catch (err) {
          console.error("حدث خطأ أثناء التصوير:", err);
        } finally {
          ffmpegProcess.stdin.end();
        }

      } catch (error) {
        console.error("خطأ عام في العملية:", error);
      }
    })(); 

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`VideoForge Server is running at http://localhost:${port}`);
});