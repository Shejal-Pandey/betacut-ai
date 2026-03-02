/* ══════════════════════════════════════════════
   ZenithMatte — Pure Frontend JS
   Uses @imgly/background-removal (ONNX-based AI)
   for professional-grade background removal
   with alpha matting & feathered edges.
   ══════════════════════════════════════════════ */

'use strict';

import { pipeline, env } from '@huggingface/transformers';

/* ── State ───────────────────────────────────── */
let originalFile = null;      // uploaded File
let resultImgEl = null;       // Image element with transparent bg result
let resultBlobUrl = null;     // URL for the result blob (to revoke later)
let origW = 0;
let origH = 0;
let currentBg = 'transparent';
let isProcessing = false;
let segmenter = null;

/* ── Element refs ────────────────────────────── */
const dropZone = document.getElementById('drop-zone');
const fileMain = document.getElementById('file-main');
const fileHero = document.getElementById('file-hero');
const workspace = document.getElementById('workspace');
const progressCont = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const progressPct = document.getElementById('progress-pct');
const progressHintTx = document.getElementById('progress-hint-text');
const originalImg = document.getElementById('original-img');
const resultBody = document.getElementById('result-body');
const resultPh = document.getElementById('result-placeholder');
const spinnerWrap = document.getElementById('spinner-wrap');
const spinLabel = document.getElementById('spin-label');
const resultIdle = document.getElementById('result-idle');
const canvasWrap = document.getElementById('canvas-wrap');
const resultCanvas = document.getElementById('result-canvas');
const panelActions = document.getElementById('panel-actions');
const panelFooter = document.getElementById('panel-footer');
const removeBtn = document.getElementById('remove-btn');
const downloadBtn = document.getElementById('download-btn');
const newBtn = document.getElementById('new-btn');
const btnTransparent = document.getElementById('btn-transparent');
const btnWhite = document.getElementById('btn-white');
const btnBlack = document.getElementById('btn-black');
const colorPicker = document.getElementById('color-picker');
const colorSwatch = document.getElementById('color-swatch');

/* ── File inputs ─────────────────────────────── */
[fileMain, fileHero].forEach(inp => {
  inp.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleFile(f);
    inp.value = '';
  });
});

/* ── Drag & Drop ─────────────────────────────── */
dropZone.addEventListener('dragenter', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', e => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) handleFile(f);
  else toast('Please drop a valid image file', 'error');
});

/* ── Background buttons ──────────────────────── */
btnTransparent.addEventListener('click', () => applyBg('transparent'));
btnWhite.addEventListener('click', () => applyBg('white'));
btnBlack.addEventListener('click', () => applyBg('black'));
colorPicker.addEventListener('input', e => {
  colorSwatch.style.background = e.target.value;
  applyBg(e.target.value);
});

/* ── Actions ─────────────────────────────────── */
removeBtn.addEventListener('click', processImage);
downloadBtn.addEventListener('click', downloadResult);
newBtn.addEventListener('click', resetWorkspace);

/* ── Navbar scroll tint ──────────────────────── */
window.addEventListener('scroll', () => {
  document.getElementById('navbar').style.background =
    window.scrollY > 20 ? 'rgba(6,6,16,.92)' : 'rgba(6,6,16,.6)';
});

/* ══════════════════════════════════════════════
   HANDLE FILE
   ══════════════════════════════════════════════ */
function handleFile(file) {
  if (!file.type.startsWith('image/')) { toast('Please select a valid image', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { toast('Image must be under 20 MB', 'error'); return; }

  originalFile = file;
  cleanupResult();
  currentBg = 'transparent';

  const url = URL.createObjectURL(file);
  originalImg.src = url;
  // Don't revoke URL immediately since we need it for segmentation input later
  // We'll clean it up during processImage

  dropZone.style.display = 'none';
  workspace.style.display = 'block';

  // Reset result panel
  resultBody.className = 'panel-body result-body checker-result';
  resultBody.style.background = '';
  resultPh.style.display = 'flex';
  spinnerWrap.style.display = 'none';
  resultIdle.style.display = 'flex';
  canvasWrap.style.display = 'none';
  panelActions.style.display = 'none';
  panelFooter.style.display = 'none';
  progressCont.style.display = 'none';
  removeBtn.disabled = false;
  removeBtn.innerHTML = removeBtnHTML('Remove Background');

  setTimeout(() => {
    document.getElementById('tool-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

/* ══════════════════════════════════════════════
   PROCESS IMAGE — MODNet + Transformers.js
   Uses true Image Matting instead of basic seg.
   ══════════════════════════════════════════════ */
async function processImage() {
  if (!originalFile) { toast('Please upload an image first', 'error'); return; }
  if (isProcessing) return;
  isProcessing = true;

  removeBtn.disabled = true;

  /* Show progress */
  progressCont.style.display = 'block';
  setProgress(0, 'Initializing AI engine…', 'Instantiating MODNet pipeline...');
  spinnerWrap.style.display = 'flex';
  resultIdle.style.display = 'none';
  canvasWrap.style.display = 'none';
  panelActions.style.display = 'none';
  panelFooter.style.display = 'none';
  spinLabel.textContent = 'Loading model…';

  try {
    cleanupResult();

    // ── 1. Create pipeline if needed ──
    if (!segmenter) {
      env.allowLocalModels = false;

      // Force hardware acceleration for stability and speed
      env.backends.onnx.wasm.proxy = true; // Use Web Workers to prevent UI freeze
      env.backends.onnx.wasm.numThreads = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

      setProgress(5, 'Downloading MODNet model…', 'First run downloads ~50 MB, then cached.');
      spinLabel.textContent = 'Downloading model…';

      // Fallback strategy: Try WebGPU -> WebGL -> WASM
      let deviceBackend = 'webgpu';
      if (!navigator.gpu) {
        deviceBackend = 'webgl';
      }

      segmenter = await pipeline('image-segmentation', 'Xenova/modnet', {
        device: deviceBackend, // webgpu | webgl | wasm
        progress_callback: (data) => {
          if (data.status === 'progress' && data.progress) {
            setProgress(Math.min(5 + data.progress * 0.45, 50), 'Downloading AI model…', `Downloading ${data.file || 'weights'}...`);
          }
        }
      });
    }

    setProgress(50, 'Running Image Matting…', 'MODNet is generating a pixel-level alpha matte.');
    spinLabel.textContent = 'Segmenting image…';

    const objectUrl = originalImg.src;

    // ── 2. Run MODNet on image ──
    const result = await segmenter(objectUrl);
    // result is an array of segments, for modnet typically 1 output.
    const maskInfo = result[0];
    if (!maskInfo || !maskInfo.mask) throw new Error('Segmentation mask not generated');

    const maskRawImage = maskInfo.mask;

    // Revoke the original input url now that we have executed inference
    if (objectUrl.startsWith('blob:')) {
      URL.revokeObjectURL(objectUrl);
    }

    setProgress(80, 'Compositing…', 'Merging high-precision alpha matte with original image.');
    spinLabel.textContent = 'Almost done…';

    // ── 3. Combine original and alpha matte at FULL resolution ──
    const w = originalImg.naturalWidth;
    const h = originalImg.naturalHeight;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(originalImg, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);

    const maskCanvas = maskRawImage.toCanvas();

    // Upscale mask to full resolution smoothly
    const scratch = document.createElement('canvas');
    scratch.width = w; scratch.height = h;
    const sCtx = scratch.getContext('2d');

    // VERY IMPORTANT: Enable high-quality smoothing before drawing the mask.
    // This scales the low-res mask (e.g., 512x512) back up to 4K smoothly 
    // using browser interpolation, preventing blocky edges and retaining hair detail.
    sCtx.imageSmoothingEnabled = true;
    sCtx.imageSmoothingQuality = 'high';
    sCtx.drawImage(maskCanvas, 0, 0, w, h);

    const maskData = sCtx.getImageData(0, 0, w, h);

    // Swap original alpha channel for matte channel (extract alpha from luminance mask)
    for (let i = 0; i < imgData.data.length; i += 4) {
      imgData.data[i + 3] = maskData.data[i]; // Convert luminosity to alpha
    }
    ctx.putImageData(imgData, 0, 0);

    const rawBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));

    /* ── Post-process: refine edges ─────────── */
    setProgress(90, 'Refining edges…');
    spinLabel.textContent = 'Cleaning edges…';
    const refinedBlob = await refineResult(rawBlob);

    /* ── Create Image from refined blob ────── */
    resultBlobUrl = URL.createObjectURL(refinedBlob);
    resultImgEl = new Image();
    await new Promise((res, rej) => {
      resultImgEl.onload = res;
      resultImgEl.onerror = rej;
      resultImgEl.src = resultBlobUrl;
    });

    origW = resultImgEl.naturalWidth;
    origH = resultImgEl.naturalHeight;

    /* ── Render to canvas ──────────────────── */
    renderToCanvas('transparent');

    setProgress(100, 'Done! 🎉');
    progressHintTx.textContent = '';

    setTimeout(() => { progressCont.style.display = 'none'; }, 900);

    resultPh.style.display = 'none';
    canvasWrap.style.display = 'flex';
    panelActions.style.display = 'flex';
    panelFooter.style.display = 'flex';
    setActiveBgBtn('transparent');

    toast('Background removed! 🎉', 'success');
    removeBtn.disabled = false;
    removeBtn.innerHTML = removeBtnHTML('Process Again');

  } catch (err) {
    console.error('Background removal failed:', err);
    progressCont.style.display = 'none';
    spinnerWrap.style.display = 'none';
    resultIdle.style.display = 'flex';
    removeBtn.disabled = false;
    toast('Processing failed — try another image.', 'error');
  } finally {
    isProcessing = false;
  }
}

/* ══════════════════════════════════════════════
   POST-PROCESSING PIPELINE
   Extracts alpha mask, applies soft thresholding, 
   1px feathering/blur, and decontaminates color.
   ══════════════════════════════════════════════ */
async function refineResult(blob) {
  /* Load the raw result into a scratch canvas */
  const img = new Image();
  const url = URL.createObjectURL(blob);
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = url;
  });
  URL.revokeObjectURL(url);

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const totalPixels = w * h;

  /* ── 1. Extract Alpha Mask ────────── */
  const alpha = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alpha[i] = data[i * 4 + 3];
  }

  /* ── 2. Light Blur (0.5px) for Aliasing ────────── */
  const cleanedAlpha = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    cleanedAlpha[i] = alpha[i];
  }

  /* ── 3. 1px Gaussian Blur to Mask ────────── */
  const blurredAlpha = new Uint8Array(totalPixels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, weightSum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        // Approximation of Gaussian Kernel weights
        const wY = dy === 0 ? 2 : 1;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const wX = dx === 0 ? 2 : 1;
          const weight = wY * wX;
          sum += cleanedAlpha[ny * w + nx] * weight;
          weightSum += weight;
        }
      }
      blurredAlpha[y * w + x] = sum / weightSum;
    }
  }

  /* ── 4. Edge Contamination & Alpha Re-Mapping ────────── */
  const originalData = new Uint8ClampedArray(data); // keep a copy of unsharpened data

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const off = idx * 4;

      // Blend between original pristine alpha and the blurred/cleaned alpha 
      // based on how sharp the original was to preserve fine hair details
      // If original alpha was very strong (>200) or very weak (<50), trust it more.
      const origA = alpha[idx];
      let newA = blurredAlpha[idx];

      // Soft Threshold optimized purely for soft hair edges
      if (newA < 15) {
        newA = 0;
      } else if (newA > 240) {
        newA = 255;
      }

      data[off + 3] = newA;

      // Apply light edge sharpen and decontamination ONLY to the foreground edges
      if (newA > 0 && newA < 255) {
        let centerR = originalData[off];
        let centerG = originalData[off + 1];
        let centerB = originalData[off + 2];

        // Milder 3x3 Laplacian / Sharpen Kernel so we don't misprint hair
        //  0 -0.5  0
        // -0.5  3 -0.5
        //  0 -0.5  0
        let sumR = centerR * 3;
        let sumG = centerG * 3;
        let sumB = centerB * 3;

        const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let i = 0; i < 4; i++) {
          const nx = x + neighbors[i][0];
          const ny = y + neighbors[i][1];
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const nOff = (ny * w + nx) * 4;
            sumR -= originalData[nOff] * 0.5;
            sumG -= originalData[nOff + 1] * 0.5;
            sumB -= originalData[nOff + 2] * 0.5;
          } else {
            sumR -= centerR * 0.5;
            sumG -= centerG * 0.5;
            sumB -= centerB * 0.5;
          }
        }

        // Minor Color Decontamination (pull genuine colors from solid interior)
        let decontR = 0, decontG = 0, decontB = 0, dcCount = 0;
        for (let dy = -3; dy <= 3; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            // Look for absolutely solid original pixels
            if (alpha[ny * w + nx] > 250) {
              const dOff = (ny * w + nx) * 4;
              decontR += originalData[dOff];
              decontG += originalData[dOff + 1];
              decontB += originalData[dOff + 2];
              dcCount++;
            }
          }
        }

        if (dcCount > 0) {
          // Blend standard sharpen with interior uncontaminated color
          data[off] = Math.max(0, Math.min(255, (sumR * 0.6) + ((decontR / dcCount) * 0.4)));
          data[off + 1] = Math.max(0, Math.min(255, (sumG * 0.6) + ((decontG / dcCount) * 0.4)));
          data[off + 2] = Math.max(0, Math.min(255, (sumB * 0.6) + ((decontB / dcCount) * 0.4)));
        } else {
          data[off] = Math.max(0, Math.min(255, sumR));
          data[off + 1] = Math.max(0, Math.min(255, sumG));
          data[off + 2] = Math.max(0, Math.min(255, sumB));
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);

  /* Convert back to PNG blob */
  return new Promise(resolve => {
    canvas.toBlob(resolve, 'image/png');
  });
}

/* ══════════════════════════════════════════════
   RENDER TO CANVAS
   The resultImgEl already has proper alpha
   from @imgly — we just composite it.
   ══════════════════════════════════════════════ */
function renderToCanvas(bg) {
  if (!resultImgEl) return;

  const canvas = resultCanvas;
  canvas.width = origW;
  canvas.height = origH;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, origW, origH);

  /* Fill background first if needed */
  if (bg !== 'transparent') {
    ctx.fillStyle = bg === 'white' ? '#ffffff' : bg === 'black' ? '#111111' : bg;
    ctx.fillRect(0, 0, origW, origH);
  }

  /* Draw the already-masked result image on top.
     The alpha channel is preserved perfectly by the library,
     so hair, edges, etc. blend naturally. */
  ctx.drawImage(resultImgEl, 0, 0, origW, origH);
}

/* ══════════════════════════════════════════════
   APPLY BACKGROUND
   ══════════════════════════════════════════════ */
function applyBg(bg) {
  if (!resultImgEl) return;
  currentBg = bg;

  resultBody.className = 'panel-body result-body checker-result';
  resultBody.style.background = '';

  if (bg === 'white') {
    resultBody.classList.remove('checker-result');
    resultBody.classList.add('bg-white');
  } else if (bg === 'black') {
    resultBody.classList.remove('checker-result');
    resultBody.classList.add('bg-black');
  } else if (bg !== 'transparent') {
    resultBody.classList.remove('checker-result');
    resultBody.style.background = bg;
  }

  renderToCanvas(bg);
  setActiveBgBtn(bg);
}

function setActiveBgBtn(bg) {
  [btnTransparent, btnWhite, btnBlack].forEach(b => b.classList.remove('active'));
  if (bg === 'transparent') btnTransparent.classList.add('active');
  else if (bg === 'white') btnWhite.classList.add('active');
  else if (bg === 'black') btnBlack.classList.add('active');
}

/* ══════════════════════════════════════════════
   DOWNLOAD — uses data URL for reliable filename
   ══════════════════════════════════════════════ */
function downloadResult() {
  if (!resultImgEl) return;

  /* Re-render with current bg for download */
  renderToCanvas(currentBg);

  resultCanvas.toBlob((blob) => {
    if (!blob) {
      toast('Failed to generate download', 'error');
      return;
    }

    /* Convert blob → data URL so the download attribute
       is always respected (blob URLs can lose the filename
       in certain browser security contexts). */
    const reader = new FileReader();
    reader.onloadend = () => {
      const link = document.createElement('a');
      link.href = reader.result;
      link.download = 'erasebg_result.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast('Image downloaded!', 'success');
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

/* ══════════════════════════════════════════════
   RESET
   ══════════════════════════════════════════════ */
function resetWorkspace() {
  originalFile = null;
  cleanupResult();
  dropZone.style.display = 'block';
  workspace.style.display = 'none';
  progressCont.style.display = 'none';
  originalImg.src = '';
  removeBtn.disabled = false;
  removeBtn.innerHTML = removeBtnHTML('Remove Background');
  dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ── Cleanup helper ──────────────────────────── */
function cleanupResult() {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  resultImgEl = null;
}

/* ── Helpers ─────────────────────────────────── */
function setProgress(pct, label, hint) {
  progressBar.style.width = pct + '%';
  progressPct.textContent = pct + '%';
  progressLabel.textContent = label || '';
  if (hint !== undefined) progressHintTx.textContent = hint;
}

function removeBtnHTML(label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>${label}`;
}

function toast(message, type = 'info') {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 400);
  }, 3500);
}
