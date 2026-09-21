"use strict";

// ------------------------------------------------------------------
// 상수 / DOM 참조
// ------------------------------------------------------------------
const RATIO_SIZES = {
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "9:16": { w: 1080, h: 1920 },
};
const ACCEPTED_TYPES = ["image/png", "image/jpeg"];
const TEMPLATES_KEY = "jjalcard_templates_v1";

const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
const canvasWrap = document.getElementById("canvasWrap");
const emptyHint = document.getElementById("emptyHint");
const ratioTabs = document.getElementById("ratioTabs");
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const addTextBtn = document.getElementById("addTextBtn");
const textListEl = document.getElementById("textList");
const downloadBtn = document.getElementById("downloadBtn");
const exportThreeBtn = document.getElementById("exportThreeBtn");
const themeToggle = document.getElementById("themeToggle");
const templateNameInput = document.getElementById("templateNameInput");
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const updateTemplateBtn = document.getElementById("updateTemplateBtn");
const templateListEl = document.getElementById("templateList");
const isOriginalCheckbox = document.getElementById("isOriginalCheckbox");
const sourceFields = document.getElementById("sourceFields");
const sourceUrlInput = document.getElementById("sourceUrlInput");
const sourceLicenseInput = document.getElementById("sourceLicenseInput");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const importJsonBtn = document.getElementById("importJsonBtn");
const importJsonFileInput = document.getElementById("importJsonFileInput");
const toastHost = document.getElementById("toastHost");

// ------------------------------------------------------------------
// 상태 — 텍스트 위치/크기는 전부 0~1 비율로 저장한다 (절대 픽셀 금지)
// ------------------------------------------------------------------
let state = {
  image: null,
  imageIsSample: true,
  imageSource: { isOriginal: true, url: null, license: null },
  ratio: "1:1",
  texts: [],
  activeTemplateId: null,
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeDefaultTexts() {
  return [
    { id: crypto.randomUUID(), content: "위쪽 문구", x: 0.5, y: 0.18, fontSizeRatio: 0.08, color: "#ffffff" },
    { id: crypto.randomUUID(), content: "아래쪽 문구를 자유롭게 수정하세요", x: 0.5, y: 0.82, fontSizeRatio: 0.06, color: "#ffffff" },
  ];
}

// ------------------------------------------------------------------
// 토스트
// ------------------------------------------------------------------
function showToast(message, type) {
  const el = document.createElement("div");
  el.className = "toast" + (type === "info" ? " info" : "");
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ------------------------------------------------------------------
// 자소 클러스터 분할 (이모지·국기 등 결합 문자가 줄바꿈에서 쪼개지지 않게)
// ------------------------------------------------------------------
function splitGraphemes(str) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(seg.segment(str), (s) => s.segment);
  }
  return Array.from(str); // 서로게이트 페어는 처리되나 ZWJ 결합까지는 못 잡는 폴백
}

// ------------------------------------------------------------------
// 텍스트 줄바꿈 — 명시적 개행 우선 분리 후, 자소 단위로 폭에 맞춰 wrap
// ------------------------------------------------------------------
function wrapLines(ctx, text, maxWidth) {
  const paragraphs = text.split("\n");
  const lines = [];
  for (const para of paragraphs) {
    if (para === "") {
      lines.push("");
      continue;
    }
    const graphemes = splitGraphemes(para);
    let current = "";
    for (const g of graphemes) {
      const trial = current + g;
      if (ctx.measureText(trial).width > maxWidth && current !== "") {
        lines.push(current);
        current = g;
      } else {
        current = trial;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

// ------------------------------------------------------------------
// 텍스트 레이아웃 계산 — 폰트 자동 축소 + 위치 클램핑
// 미리보기/다운로드/썸네일/드래그 판정이 전부 이 함수 하나만 쓴다.
// ------------------------------------------------------------------
function computeTextRenderLayout(ctx, canvasW, canvasH, textObj) {
  const marginY = canvasH * 0.03;
  const maxWidth = canvasW * 0.92;
  const minFontRatio = 0.015;
  let fontSizeRatio = textObj.fontSizeRatio;
  let lines = [];
  let lineHeight = 0;
  let blockHeight = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    const fontSize = Math.max(fontSizeRatio, minFontRatio) * Math.min(canvasW, canvasH);
    ctx.font = `bold ${fontSize}px "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    lines = wrapLines(ctx, textObj.content ?? "", maxWidth);
    lineHeight = fontSize * 1.32;
    blockHeight = lineHeight * lines.length;

    const availableHeight = canvasH - marginY * 2;
    if (blockHeight <= availableHeight || fontSizeRatio <= minFontRatio) break;
    fontSizeRatio = fontSizeRatio * Math.min(0.92, availableHeight / blockHeight);
  }

  const fontSize = Math.max(fontSizeRatio, minFontRatio) * Math.min(canvasW, canvasH);

  // 블록 중심 y를 상/하 여백 안쪽으로 클램핑
  let centerY = textObj.y * canvasH;
  const halfBlock = blockHeight / 2;
  const minCenter = marginY + halfBlock;
  const maxCenter = canvasH - marginY - halfBlock;
  if (minCenter <= maxCenter) {
    centerY = Math.min(Math.max(centerY, minCenter), maxCenter);
  } else {
    centerY = canvasH / 2; // 블록이 캔버스보다 큼 — 세로 중앙 배치
  }

  const centerX = textObj.x * canvasW;
  let maxLineWidth = 0;
  for (const line of lines) {
    maxLineWidth = Math.max(maxLineWidth, ctx.measureText(line).width);
  }

  return {
    lines,
    fontSize,
    lineHeight,
    blockHeight,
    centerX,
    centerY,
    maxLineWidth,
    top: centerY - blockHeight / 2,
  };
}

// ------------------------------------------------------------------
// 공유 렌더 함수 — 미리보기 canvas와 다운로드용 canvas가 반드시 이 함수만 쓴다.
// ------------------------------------------------------------------
function drawImageCover(ctx, img, canvasW, canvasH) {
  const imgRatio = img.width / img.height;
  const canvasRatio = canvasW / canvasH;
  let sx, sy, sw, sh;
  if (imgRatio > canvasRatio) {
    sh = img.height;
    sw = sh * canvasRatio;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / canvasRatio;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
}

function renderToCanvas(canvas, s) {
  const size = RATIO_SIZES[s.ratio];
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size.w, size.h);

  if (s.image) {
    drawImageCover(ctx, s.image, size.w, size.h);
  } else {
    ctx.fillStyle = "#7b6ef6";
    ctx.fillRect(0, 0, size.w, size.h);
  }

  for (const t of s.texts) {
    if (!t.content) continue;
    const layout = computeTextRenderLayout(ctx, size.w, size.h, t);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.font = `bold ${layout.fontSize}px "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    layout.lines.forEach((line, i) => {
      const ly = layout.top + layout.lineHeight * i + layout.lineHeight / 2;
      ctx.lineWidth = Math.max(2, layout.fontSize * 0.08);
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.strokeText(line, layout.centerX, ly);
      ctx.fillStyle = t.color || "#ffffff";
      ctx.fillText(line, layout.centerX, ly);
    });
  }
  return ctx;
}

function hitTestText(canvasW, canvasH, px, py) {
  const ctx = previewCtx;
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i];
    if (!t.content) continue;
    const layout = computeTextRenderLayout(ctx, canvasW, canvasH, t);
    const halfW = layout.maxLineWidth / 2 + 12;
    const halfH = layout.blockHeight / 2 + 12;
    if (
      px >= layout.centerX - halfW && px <= layout.centerX + halfW &&
      py >= layout.centerY - halfH && py <= layout.centerY + halfH
    ) {
      return t;
    }
  }
  return null;
}

function render() {
  renderToCanvas(previewCanvas, state);
  emptyHint.classList.toggle("hidden", !state.imageIsSample);
}

// ------------------------------------------------------------------
// 샘플 이미지 (직접 캔버스로 그린 그라디언트 — 본인 제작이라 출처 문제 없음)
// ------------------------------------------------------------------
function buildSampleImage() {
  const c = document.createElement("canvas");
  c.width = 1080;
  c.height = 1080;
  const ctx = c.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 1080, 1080);
  grad.addColorStop(0, "#5b47f0");
  grad.addColorStop(1, "#c4457a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1080);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(820, 260, 220, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(260, 820, 180, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  const img = new Image();
  img.src = c.toDataURL("image/png");
  return img;
}

function loadSample() {
  const img = buildSampleImage();
  img.onload = () => {
    state.image = img;
    state.imageIsSample = true;
    state.imageSource = { isOriginal: true, url: null, license: null };
    state.texts = makeDefaultTexts();
    render();
    renderTextList();
    syncSourceFieldsUI();
  };
}

// ------------------------------------------------------------------
// 이미지 업로드 (클릭 + 드래그앤드롭, MIME 타입 기준 검사)
// ------------------------------------------------------------------
function handleFile(file) {
  if (!file) return;
  if (!ACCEPTED_TYPES.includes(file.type)) {
    showToast("PNG/JPEG만 지원됩니다. 다른 형식의 파일은 무시했어요.");
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => showToast("파일을 읽는 중 오류가 발생했습니다. 기존 작업은 유지됩니다.");
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // 캔버스로 다시 그려서 저장/다운로드하므로 원본 EXIF(위치정보 등)는
      // 픽셀 데이터만 쓰는 이 시점부터 빠져나가고 이후 어디에도 남지 않는다.
      state.image = img;
      state.imageIsSample = false;
      state.imageSource = { isOriginal: false, url: null, license: null };
      render();
      syncSourceFieldsUI();
    };
    img.onerror = () => showToast("이미지를 불러올 수 없습니다. 파일이 손상되었을 수 있어요.");
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

uploadBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  handleFile(e.target.files[0]);
  fileInput.value = "";
});
canvasWrap.addEventListener("dragover", (e) => e.preventDefault());
canvasWrap.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

// ------------------------------------------------------------------
// 이미지 출처 표기
// ------------------------------------------------------------------
function syncSourceFieldsUI() {
  const src = state.imageSource || { isOriginal: true, url: null, license: null };
  isOriginalCheckbox.checked = !!src.isOriginal;
  sourceFields.hidden = !!src.isOriginal;
  sourceUrlInput.value = src.url || "";
  sourceLicenseInput.value = src.license || "";
}
isOriginalCheckbox.addEventListener("change", () => {
  state.imageSource.isOriginal = isOriginalCheckbox.checked;
  if (state.imageSource.isOriginal) {
    state.imageSource.url = null;
    state.imageSource.license = null;
  }
  syncSourceFieldsUI();
});
sourceUrlInput.addEventListener("input", () => {
  state.imageSource.url = sourceUrlInput.value.trim() || null;
});
sourceLicenseInput.addEventListener("input", () => {
  state.imageSource.license = sourceLicenseInput.value.trim() || null;
});

// ------------------------------------------------------------------
// 텍스트 레이어 목록 UI
// ------------------------------------------------------------------
function renderTextList() {
  textListEl.innerHTML = "";
  state.texts.forEach((t) => {
    const item = document.createElement("div");
    item.className = "text-item";
    item.innerHTML = `
      <textarea>${t.content.replace(/</g, "&lt;")}</textarea>
      <div class="field-row">
        크기 <input type="range" min="0.02" max="0.16" step="0.005" value="${t.fontSizeRatio}">
      </div>
      <div class="field-row">
        색상 <input type="color" value="${t.color}">
      </div>
      <button class="delete-btn" type="button">삭제</button>
    `;
    const textarea = item.querySelector("textarea");
    const rangeInput = item.querySelector('input[type="range"]');
    const colorInput = item.querySelector('input[type="color"]');
    const delBtn = item.querySelector(".delete-btn");

    textarea.addEventListener("input", () => { t.content = textarea.value; render(); });
    rangeInput.addEventListener("input", () => { t.fontSizeRatio = parseFloat(rangeInput.value); render(); });
    colorInput.addEventListener("input", () => { t.color = colorInput.value; render(); });
    delBtn.addEventListener("click", () => {
      state.texts = state.texts.filter((x) => x.id !== t.id);
      renderTextList();
      render();
    });
    textListEl.appendChild(item);
  });
}

addTextBtn.addEventListener("click", () => {
  state.texts.push({
    id: crypto.randomUUID(),
    content: "새 문구",
    x: 0.5,
    y: 0.5,
    fontSizeRatio: 0.07,
    color: "#ffffff",
  });
  renderTextList();
  render();
});

// ------------------------------------------------------------------
// 캔버스 위 드래그로 텍스트 위치 이동
// ------------------------------------------------------------------
let dragTarget = null;
function getCanvasPoint(evt) {
  const rect = previewCanvas.getBoundingClientRect();
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  const scaleX = previewCanvas.width / rect.width;
  const scaleY = previewCanvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}
function startDrag(evt) {
  const p = getCanvasPoint(evt);
  const hit = hitTestText(previewCanvas.width, previewCanvas.height, p.x, p.y);
  if (hit) {
    dragTarget = hit;
    previewCanvas.classList.add("dragging");
    evt.preventDefault();
  }
}
function moveDrag(evt) {
  if (!dragTarget) return;
  const p = getCanvasPoint(evt);
  dragTarget.x = Math.min(1, Math.max(0, p.x / previewCanvas.width));
  dragTarget.y = Math.min(1, Math.max(0, p.y / previewCanvas.height));
  render();
  evt.preventDefault();
}
function endDrag() {
  dragTarget = null;
  previewCanvas.classList.remove("dragging");
}
previewCanvas.addEventListener("mousedown", startDrag);
window.addEventListener("mousemove", moveDrag);
window.addEventListener("mouseup", endDrag);
previewCanvas.addEventListener("touchstart", startDrag, { passive: false });
window.addEventListener("touchmove", moveDrag, { passive: false });
window.addEventListener("touchend", endDrag);

// ------------------------------------------------------------------
// 비율 탭
// ------------------------------------------------------------------
function setActiveRatioTab() {
  ratioTabs.querySelectorAll(".ratio-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.ratio === state.ratio);
  });
}
ratioTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".ratio-tab");
  if (!btn) return;
  state.ratio = btn.dataset.ratio;
  setActiveRatioTab();
  render();
});

// ------------------------------------------------------------------
// 테마 토글
// ------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("jjalcard_theme", theme);
}
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
});
applyTheme(localStorage.getItem("jjalcard_theme") || "light");

// ------------------------------------------------------------------
// 템플릿 저장소 (localStorage) — id는 항상 crypto.randomUUID(), index 참조 금지
// ------------------------------------------------------------------
function loadTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveTemplatesToStorage(templates) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
    return true;
  } catch (e) {
    return false;
  }
}
function makeThumbnail(s) {
  const c = document.createElement("canvas");
  const full = document.createElement("canvas");
  renderToCanvas(full, s);
  const THUMB = 140;
  const size = RATIO_SIZES[s.ratio];
  c.width = THUMB;
  c.height = Math.round((THUMB * size.h) / size.w);
  c.getContext("2d").drawImage(full, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

function setActiveTemplateUI(id) {
  state.activeTemplateId = id;
  updateTemplateBtn.hidden = !id;
}

function renderTemplateList() {
  const templates = loadTemplates().sort((a, b) => b.updatedAt - a.updatedAt);
  templateListEl.innerHTML = "";
  templates.forEach((tpl) => {
    const row = document.createElement("div");
    row.className = "template-row";
    row.innerHTML = `
      <img class="template-thumb" src="${tpl.thumbnail || ""}" alt="">
      <div class="template-info">
        <div class="name"></div>
        <div class="date">${new Date(tpl.updatedAt).toLocaleString()}</div>
      </div>
      <div class="template-actions">
        <button type="button" class="load">불러오기</button>
        <button type="button" class="del">삭제</button>
      </div>
    `;
    row.querySelector(".name").textContent = tpl.name;
    row.querySelector(".load").addEventListener("click", () => loadTemplate(tpl.id));
    row.querySelector(".del").addEventListener("click", () => deleteTemplate(tpl.id));
    templateListEl.appendChild(row);
  });
}

function loadTemplate(id) {
  const tpl = loadTemplates().find((t) => t.id === id);
  if (!tpl) return;
  state.ratio = tpl.ratio;
  state.texts = deepClone(tpl.texts);
  state.imageSource = tpl.imageSource ? deepClone(tpl.imageSource) : { isOriginal: true, url: null, license: null };
  state.imageIsSample = false;
  templateNameInput.value = tpl.name;
  setActiveTemplateUI(tpl.id);
  syncSourceFieldsUI();
  setActiveRatioTab();

  if (tpl.image) {
    const img = new Image();
    img.onload = () => { state.image = img; render(); renderTextList(); };
    img.src = tpl.image;
  } else {
    state.image = null;
    render();
    renderTextList();
  }
}

function deleteTemplate(id) {
  const templates = loadTemplates().filter((t) => t.id !== id); // id 기준 삭제 — index 절대 사용 금지
  saveTemplatesToStorage(templates);
  if (state.activeTemplateId === id) setActiveTemplateUI(null);
  renderTemplateList();
  showToast("템플릿을 삭제했습니다.", "info");
}

saveTemplateBtn.addEventListener("click", () => {
  const name = templateNameInput.value.trim() || `템플릿 ${new Date().toLocaleString()}`;
  const entry = {
    id: crypto.randomUUID(),
    name,
    image: state.image ? state.image.src : null,
    imageSource: deepClone(state.imageSource),
    texts: deepClone(state.texts),
    ratio: state.ratio,
    thumbnail: makeThumbnail(state),
    updatedAt: Date.now(),
  };
  const templates = loadTemplates();
  templates.push(entry);
  if (!saveTemplatesToStorage(templates)) {
    showToast("저장 공간이 부족해 템플릿을 저장하지 못했습니다.");
    return;
  }
  setActiveTemplateUI(entry.id);
  renderTemplateList();
  showToast("새 템플릿으로 저장했습니다.", "info");
});

updateTemplateBtn.addEventListener("click", () => {
  if (!state.activeTemplateId) return;
  const templates = loadTemplates();
  const idx = templates.findIndex((t) => t.id === state.activeTemplateId); // 조회만 index, 대상 식별은 id
  if (idx === -1) {
    showToast("원본 템플릿을 찾을 수 없습니다.");
    return;
  }
  templates[idx] = {
    ...templates[idx],
    name: templateNameInput.value.trim() || templates[idx].name,
    image: state.image ? state.image.src : null,
    imageSource: deepClone(state.imageSource),
    texts: deepClone(state.texts),
    ratio: state.ratio,
    thumbnail: makeThumbnail(state),
    updatedAt: Date.now(),
  };
  if (!saveTemplatesToStorage(templates)) {
    showToast("저장 공간이 부족해 업데이트하지 못했습니다.");
    return;
  }
  renderTemplateList();
  showToast("현재 템플릿을 업데이트했습니다.", "info");
});

// ------------------------------------------------------------------
// 다운로드 공통 헬퍼
// ------------------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

downloadBtn.addEventListener("click", async () => {
  const originalLabel = downloadBtn.textContent;
  downloadBtn.textContent = "내보내는 중...";
  downloadBtn.disabled = true;
  try {
    const exportCanvas = document.createElement("canvas");
    renderToCanvas(exportCanvas, state);
    const blob = await new Promise((resolve) => exportCanvas.toBlob(resolve, "image/png"));
    downloadBlob(blob, `card-${state.ratio.replace(":", "x")}-${Date.now()}.png`);
  } finally {
    downloadBtn.textContent = originalLabel;
    downloadBtn.disabled = false;
  }
});

// ------------------------------------------------------------------
// 카드5: 템플릿 JSON 내보내기 / 가져오기
// 문법 오류·필수 항목 누락 JSON은 저장 전에 거부하고 기존 템플릿을 그대로 유지한다.
// ------------------------------------------------------------------
exportJsonBtn.addEventListener("click", () => {
  const templates = loadTemplates();
  if (templates.length === 0) {
    showToast("내보낼 템플릿이 없습니다.");
    return;
  }
  const blob = new Blob([JSON.stringify(templates, null, 2)], { type: "application/json" });
  downloadBlob(blob, `templates-export-${Date.now()}.json`);
  showToast(`템플릿 ${templates.length}개를 JSON으로 내보냈습니다.`, "info");
});

function loadImageAsync(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지 디코딩 실패"));
    img.src = src;
  });
}

function validateImportedTemplates(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, reason: `JSON 문법이 올바르지 않습니다: ${e.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "최상위 값이 배열이 아닙니다. [ { ... }, { ... } ] 형식이어야 합니다." };
  }
  if (parsed.length === 0) {
    return { ok: false, reason: "가져올 템플릿이 없습니다 (빈 배열)." };
  }
  const VALID_RATIOS = Object.keys(RATIO_SIZES);
  for (let i = 0; i < parsed.length; i++) {
    const tpl = parsed[i];
    const label = `${i + 1}번째 템플릿`;
    if (typeof tpl !== "object" || tpl === null || Array.isArray(tpl)) {
      return { ok: false, reason: `${label}이 올바른 객체가 아닙니다.` };
    }
    if (typeof tpl.name !== "string" || tpl.name.trim() === "") {
      return { ok: false, reason: `${label}에 필수 항목 name(이름)이 없습니다.` };
    }
    if (!VALID_RATIOS.includes(tpl.ratio)) {
      return { ok: false, reason: `${label}의 ratio 값이 올바르지 않습니다 (1:1, 4:5, 9:16 중 하나여야 함).` };
    }
    if (!Array.isArray(tpl.texts)) {
      return { ok: false, reason: `${label}에 필수 항목 texts(배열)가 없습니다.` };
    }
    for (let j = 0; j < tpl.texts.length; j++) {
      const t = tpl.texts[j];
      const tLabel = `${label}의 ${j + 1}번째 텍스트`;
      if (typeof t !== "object" || t === null) return { ok: false, reason: `${tLabel}이 올바른 객체가 아닙니다.` };
      if (typeof t.content !== "string") return { ok: false, reason: `${tLabel}에 필수 항목 content(문구)가 없습니다.` };
      if (typeof t.x !== "number" || t.x < 0 || t.x > 1) return { ok: false, reason: `${tLabel}의 x 좌표가 0~1 범위의 숫자가 아닙니다.` };
      if (typeof t.y !== "number" || t.y < 0 || t.y > 1) return { ok: false, reason: `${tLabel}의 y 좌표가 0~1 범위의 숫자가 아닙니다.` };
      if (typeof t.fontSizeRatio !== "number" || t.fontSizeRatio <= 0) return { ok: false, reason: `${tLabel}의 fontSizeRatio가 올바른 숫자가 아닙니다.` };
      if (typeof t.color !== "string") return { ok: false, reason: `${tLabel}에 필수 항목 color가 없습니다.` };
    }
    if (tpl.image != null && (typeof tpl.image !== "string" || !tpl.image.startsWith("data:image"))) {
      return { ok: false, reason: `${label}의 image 값이 올바른 이미지 데이터 URL이 아닙니다.` };
    }
    if (tpl.imageSource != null) {
      if (typeof tpl.imageSource !== "object" || typeof tpl.imageSource.isOriginal !== "boolean") {
        return { ok: false, reason: `${label}의 imageSource.isOriginal(본인 제작 여부)이 없거나 boolean이 아닙니다.` };
      }
      if (!tpl.imageSource.isOriginal) {
        const hasUrl = typeof tpl.imageSource.url === "string" && tpl.imageSource.url.trim() !== "";
        const hasLicense = typeof tpl.imageSource.license === "string" && tpl.imageSource.license.trim() !== "";
        if (!hasUrl || !hasLicense) {
          return { ok: false, reason: `${label}: 본인 제작이 아닌 이미지는 출처 url과 사용 허가 근거(license)가 모두 있어야 합니다.` };
        }
      }
    }
  }
  return { ok: true, templates: parsed };
}

async function importTemplatesFromJson(jsonText) {
  const validation = validateImportedTemplates(jsonText);
  if (!validation.ok) return validation; // 실패 시 localStorage를 전혀 건드리지 않음 — 기존 템플릿 유지

  const built = [];
  for (const tpl of validation.templates) {
    const entry = {
      id: crypto.randomUUID(),
      name: tpl.name.trim(),
      image: tpl.image || null,
      imageSource: tpl.imageSource ? deepClone(tpl.imageSource) : { isOriginal: true, url: null, license: null },
      texts: deepClone(tpl.texts),
      ratio: tpl.ratio,
      thumbnail: null,
      updatedAt: Date.now(),
    };
    if (entry.image) {
      try {
        const img = await loadImageAsync(entry.image);
        entry.thumbnail = makeThumbnail({ image: img, texts: entry.texts, ratio: entry.ratio });
      } catch (e) {
        entry.thumbnail = null;
      }
    }
    built.push(entry);
  }

  const merged = loadTemplates().concat(built);
  if (!saveTemplatesToStorage(merged)) {
    return { ok: false, reason: "저장 공간이 부족해 가져오기를 완료하지 못했습니다." };
  }
  return { ok: true, count: built.length };
}

importJsonBtn.addEventListener("click", () => importJsonFileInput.click());
importJsonFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  importJsonFileInput.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => showToast("파일을 읽는 중 오류가 발생했습니다.");
  reader.onload = async () => {
    const result = await importTemplatesFromJson(String(reader.result));
    if (!result.ok) {
      showToast(`가져오기 거부됨: ${result.reason}`);
      return;
    }
    renderTemplateList();
    showToast(`템플릿 ${result.count}개를 가져왔습니다.`, "info");
  };
  reader.readAsText(file);
});

// ------------------------------------------------------------------
// 무압축(store) ZIP 파일을 순수 JS로 직접 만든다 (외부 라이브러리 없음).
// 브라우저가 짧은 시간 내 다중 자동 다운로드를 막는 경우가 있어
// 완성 이미지 3장 + manifest를 zip 하나로 묶어 다운로드는 항상 1번만 발생시킨다.
// ------------------------------------------------------------------
function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, dosTime, true);
    localHeader.setUint16(12, dosDate, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, data.length, true);
    localHeader.setUint32(22, data.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);
    localChunks.push(new Uint8Array(localHeader.buffer), nameBytes, data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, dosTime, true);
    centralHeader.setUint16(14, dosDate, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);
    centralChunks.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0);

  const endRecord = new DataView(new ArrayBuffer(22));
  endRecord.setUint32(0, 0x06054b50, true);
  endRecord.setUint16(8, files.length, true);
  endRecord.setUint16(10, files.length, true);
  endRecord.setUint32(12, centralSize, true);
  endRecord.setUint32(16, centralStart, true);

  return new Blob([...localChunks, ...centralChunks, new Uint8Array(endRecord.buffer)], { type: "application/zip" });
}

// ------------------------------------------------------------------
// 카드5: 완성 이미지 3개 내보내기 (1:1 / 4:5 / 9:16) — zip 하나로 다운로드
// ------------------------------------------------------------------
exportThreeBtn.addEventListener("click", async () => {
  const src = state.imageSource || { isOriginal: true, url: null, license: null };
  if (!src.isOriginal && (!src.url || !src.license)) {
    showToast("이미지 출처 정보가 없습니다. 본인 제작이 아니면 출처 URL과 사용 허가 근거를 먼저 입력해주세요.");
    return;
  }
  const originalLabel = exportThreeBtn.textContent;
  exportThreeBtn.textContent = "내보내는 중...";
  exportThreeBtn.disabled = true;
  try {
    const ratios = Object.keys(RATIO_SIZES);
    const manifest = [];
    const zipFiles = [];
    const stamp = Date.now();
    for (let i = 0; i < ratios.length; i++) {
      const ratio = ratios[i];
      const snapshotState = { ...state, ratio };
      const exportCanvas = document.createElement("canvas");
      renderToCanvas(exportCanvas, snapshotState);
      const blob = await new Promise((resolve) => exportCanvas.toBlob(resolve, "image/png"));
      const filename = `finished-${ratio.replace(":", "x")}-${i}.png`;
      zipFiles.push({ name: filename, data: new Uint8Array(await blob.arrayBuffer()) });
      manifest.push({
        file: filename,
        ratio,
        width: exportCanvas.width,
        height: exportCanvas.height,
        isOriginal: src.isOriginal,
        sourceUrl: src.isOriginal ? null : src.url,
        license: src.isOriginal ? null : src.license,
      });
    }
    const manifestJson = JSON.stringify(manifest, null, 2);
    zipFiles.push({ name: "manifest.json", data: new TextEncoder().encode(manifestJson) });
    const zipBlob = buildZip(zipFiles);
    downloadBlob(zipBlob, `finished-images-${stamp}.zip`);
    showToast("완성 이미지 3개와 출처 기록 파일을 zip으로 내보냈습니다.", "info");
  } finally {
    exportThreeBtn.textContent = originalLabel;
    exportThreeBtn.disabled = false;
  }
});

// ------------------------------------------------------------------
// 전역 에러 방어 — 예외가 나도 기존 작업이 사라지지 않게
// ------------------------------------------------------------------
window.addEventListener("error", (e) => {
  console.error("전역 오류:", e.error || e.message);
});

// ------------------------------------------------------------------
// 초기화
// ------------------------------------------------------------------
setActiveRatioTab();
renderTemplateList();
loadSample();
