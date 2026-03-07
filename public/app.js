'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  apiKey:        '',
  ghostUrl:      '',   // read from /api/config, display only
  hasFs:         false, // true when Ghost media path is mounted inside container
  immichUrl:     '',
  immichKey:     '',
  allImages:     [],
  filteredImages:[],
  postsCache:    null,
  postsCacheTime:0,
  currentPreviewImage: null,
  currentImmichAsset:  null,
  renameTarget:  null,
  editorImage:   null,  // image currently being edited
  editorResult:  null,  // { imageBase64, mimeType, fullName } from Filerobot onSave
  editorUsedIn:  [],    // usage results for save dialog
  editorSaveMode:'overwrite',
  currentEditor: null,  // Filerobot instance
  aiAvailable:   false, // true when ANTHROPIC_API_KEY is set on the server
  postsData:     [],    // flat array of all posts+pages (populated by loadPosts)
  postsFiltered: [],    // after search/filter applied
  selectedImages:[],    // array of img objects currently selected
  wpXmlSession:  null,  // session token from parse-wordpress-xml
  wpXmlSummary:  null,  // summary data from parse response
  wpImportAbort: null,  // AbortController for SSE cancellation
  // Videos
  allVideos:          [],
  filteredVideos:     [],
  hasVideoFs:         false,
  videoPreviewTarget: null,
  videosLoaded:       false,
  selectedVideos:     [],
  // Files
  allFiles:           [],
  filteredFiles:      [],
  hasFilesFs:         false,
  filesLoaded:        false,
  selectedFiles:      [],
  // Bulk delete
  bulkDeleteAbortFlag: false,
  ghostLang: 'en',         // Ghost site language, fetched after auth
};

// ── Session Storage ─────────────────────────────────────────────────────────
const SS = {
  get: k  => sessionStorage.getItem(k) || '',
  set: (k,v) => sessionStorage.setItem(k, v),
  clear: () => sessionStorage.clear(),
};

// ── Bootstrap ───────────────────────────────────────────────────────────────
(async function init() {
  // Always fetch server config to show Ghost URL on login
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    state.ghostUrl    = cfg.ghostUrl    || '';
    state.hasFs       = cfg.hasFs       || false;
    state.hasVideoFs  = cfg.hasVideoFs  || false;
    state.hasFilesFs  = cfg.hasFilesFs  || false;
    state.aiAvailable = cfg.aiAvailable || false;
    if (state.ghostUrl) {
      document.getElementById('loginGhostUrlText').textContent = state.ghostUrl;
      document.getElementById('loginGhostUrl').style.display = 'block';
      document.getElementById('headerSite').textContent = state.ghostUrl.replace(/^https?:\/\//, '');
    }
  } catch { /* non-fatal */ }

  const apiKey   = SS.get('apiKey');
  const immichUrl = SS.get('immichUrl');
  const immichKey = SS.get('immichKey');

  if (apiKey) {
    state.apiKey   = apiKey;
    state.immichUrl = immichUrl;
    state.immichKey = immichKey;
    showApp();
  }

  setupListeners();
})();

// ── Show/hide screens ───────────────────────────────────────────────────────
function showLoginPage() {
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('app').classList.remove('show');
}

function showApp() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('app').classList.add('show');
  document.getElementById('settingsApiKey').value     = state.apiKey;
  document.getElementById('settingsImmichUrl').value  = state.immichUrl;
  document.getElementById('settingsImmichKey').value  = state.immichKey;
  document.getElementById('settingsGhostUrlDisplay').textContent = state.ghostUrl || '(not configured in .env)';
  loadMedia();
  checkImmichConfig();
  // Fetch Ghost site language for dialog defaults (fire-and-forget)
  api('/api/ghost/lang').then(r => r.json()).then(d => { if (d.lang) state.ghostLang = d.lang; }).catch(() => {});
  // Hide Videos/Files tabs when filesystems not mounted
  if (!state.hasVideoFs) document.getElementById('tabBtnVideos').style.display = 'none';
  if (!state.hasFilesFs) document.getElementById('tabBtnFiles').style.display  = 'none';
}

// ── Event listeners ─────────────────────────────────────────────────────────
function setupListeners() {
  // Login
  document.getElementById('connectBtn').addEventListener('click', handleLogin);
  document.getElementById('inputApiKey').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', () => {
    SS.clear();
    Object.assign(state, { apiKey:'', allImages:[], postsCache:null });
    showLoginPage();
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'immich')      initImmichTab();
      if (btn.dataset.tab === 'posts')       initPostsTab();
      if (btn.dataset.tab === 'videos')      initVideosTab();
      if (btn.dataset.tab === 'files')       initFilesTab();
      if (btn.dataset.tab === 'html-editor') initHtmlEditorTab();
    });
  });

  // Media toolbar
  document.getElementById('searchInput').addEventListener('input', applyFilterSort);
  document.getElementById('sortSelect').addEventListener('change', applyFilterSort);
  document.getElementById('refreshBtn').addEventListener('click', () => { state.postsCache = null; loadMedia(); });
  document.getElementById('selectionDeleteBtn').addEventListener('click', () => executeBulkDelete([...state.selectedImages], 'media'));
  document.getElementById('selectionClearBtn')?.addEventListener('click', clearSelection);
  document.getElementById('selectionInsertBtn').addEventListener('click', openInsertImageModal);
  document.getElementById('insertCancelBtn').addEventListener('click', () => document.getElementById('insertImageOverlay').classList.remove('show'));
  document.getElementById('insertConfirmBtn').addEventListener('click', insertImageIntoPost);
  document.getElementById('selectionGalleryBtn').addEventListener('click', openInsertGalleryModal);
  document.getElementById('insertGalleryCancelBtn').addEventListener('click', () => document.getElementById('insertGalleryOverlay').classList.remove('show'));
  document.getElementById('insertGalleryConfirmBtn').addEventListener('click', insertGallery);

  // AI Draft Post button (navbar, always visible)
  document.getElementById('createAiPostBtn').addEventListener('click', openCreateAiPostDialog);

  // Video selection
  document.getElementById('videoSelectionDeleteBtn').addEventListener('click', () => executeBulkDelete([...state.selectedVideos], 'videos'));
  document.getElementById('videoSelectionClearBtn')?.addEventListener('click', clearVideoSelection);

  // Files selection
  document.getElementById('filesSelectionDeleteBtn').addEventListener('click', () => executeBulkDelete([...state.selectedFiles], 'files'));
  document.getElementById('filesSelectionClearBtn')?.addEventListener('click', clearFilesSelection);

  // Upload
  const zone      = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  zone.addEventListener('click', e => { if (e.target !== fileInput) fileInput.click(); });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

  // Video upload
  const videoZone      = document.getElementById('videoUploadZone');
  const videoFileInput = document.getElementById('videoFileInput');
  videoZone.addEventListener('click', e => { if (e.target !== videoFileInput) videoFileInput.click(); });
  videoZone.addEventListener('dragover',  e => { e.preventDefault(); videoZone.classList.add('drag-over'); });
  videoZone.addEventListener('dragleave', ()  => videoZone.classList.remove('drag-over'));
  videoZone.addEventListener('drop', e => { e.preventDefault(); videoZone.classList.remove('drag-over'); handleVideoUpload(e.dataTransfer.files); });
  videoFileInput.addEventListener('change', () => { handleVideoUpload(videoFileInput.files); videoFileInput.value = ''; });

  // File attachment upload
  const fileZone      = document.getElementById('fileUploadZone');
  const fileFileInput = document.getElementById('fileFileInput');
  fileZone.addEventListener('click', e => { if (e.target !== fileFileInput) fileFileInput.click(); });
  fileZone.addEventListener('dragover',  e => { e.preventDefault(); fileZone.classList.add('drag-over'); });
  fileZone.addEventListener('dragleave', ()  => fileZone.classList.remove('drag-over'));
  fileZone.addEventListener('drop', e => { e.preventDefault(); fileZone.classList.remove('drag-over'); handleFileUpload(e.dataTransfer.files); });
  fileFileInput.addEventListener('change', () => { handleFileUpload(fileFileInput.files); fileFileInput.value = ''; });

  // Preview
  document.getElementById('closePreview').addEventListener('click', closePreview);
  document.getElementById('previewOverlay').addEventListener('click', e => { if (e.target === document.getElementById('previewOverlay')) closePreview(); });

  // Delete
  document.getElementById('deleteCancelBtn').addEventListener('click', closeDeleteModal);
  document.getElementById('deleteConfirmBtn').addEventListener('click', confirmDelete);
  document.getElementById('deleteOverlay').addEventListener('click', e => { if (e.target === document.getElementById('deleteOverlay')) closeDeleteModal(); });

  // Rename
  document.getElementById('renameCancelBtn').addEventListener('click', closeRenameModal);
  document.getElementById('renameConfirmBtn').addEventListener('click', confirmRename);
  document.getElementById('renameOverlay').addEventListener('click', e => { if (e.target === document.getElementById('renameOverlay')) closeRenameModal(); });
  document.getElementById('renameInput').addEventListener('input', () => { document.getElementById('renameError').textContent = ''; });

  // Editor save dialog
  document.getElementById('editorOptA').addEventListener('click', () => selectEditorSaveMode('overwrite'));
  document.getElementById('editorOptB').addEventListener('click', () => selectEditorSaveMode('new'));
  document.getElementById('editorSaveCancelBtn').addEventListener('click', closeEditorSaveDialog);
  document.getElementById('editorSaveConfirmBtn').addEventListener('click', confirmEditorSave);
  document.getElementById('editorSaveOverlay').addEventListener('click', e => { if (e.target === document.getElementById('editorSaveOverlay')) closeEditorSaveDialog(); });

  // Usage popup
  document.getElementById('usagePopupClose').addEventListener('click', closeUsagePopup);
  document.getElementById('usageOverlay').addEventListener('click', e => { if (e.target === document.getElementById('usageOverlay')) closeUsagePopup(); });

  // Immich
  document.getElementById('immichRefreshBtn').addEventListener('click', initImmichTab);
  document.getElementById('backToAlbumsBtn').addEventListener('click', showAlbumsView);
  document.getElementById('closeImmichPreview').addEventListener('click', closeImmichPreview);
  document.getElementById('immichPreviewOverlay').addEventListener('click', e => { if (e.target === document.getElementById('immichPreviewOverlay')) closeImmichPreview(); });
  document.getElementById('useInGhostBtn').addEventListener('click', handleUseInGhost);

  // Settings
  document.getElementById('saveGhostSettings').addEventListener('click', saveGhostSettings);
  document.getElementById('saveImmichSettings').addEventListener('click', saveImmichSettings);

  // WordPress XML Import
  const wpDropZone  = document.getElementById('wpXmlDropZone');
  const wpFileInput = document.getElementById('wpXmlFileInput');
  wpFileInput.addEventListener('change', () => {
    if (wpFileInput.files[0]) handleWpXmlFileSelect(wpFileInput.files[0]);
    wpFileInput.value = '';
  });
  wpDropZone.addEventListener('click', e => {
    if (e.target !== wpDropZone && !e.target.closest('label')) return;
    wpFileInput.click();
  });
  wpDropZone.addEventListener('dragover',  e => { e.preventDefault(); wpDropZone.classList.add('drag-over'); });
  wpDropZone.addEventListener('dragleave', ()  => wpDropZone.classList.remove('drag-over'));
  wpDropZone.addEventListener('drop', e => {
    e.preventDefault(); wpDropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleWpXmlFileSelect(f);
  });
  document.getElementById('wpXmlImportBtn').addEventListener('click', startWpXmlImport);
  document.getElementById('wpImportCancelBtn').addEventListener('click', cancelWpXmlImport);
  document.getElementById('wpImportDownloadBtn').addEventListener('click', downloadWpImportLog);
  document.getElementById('wpImportDoneBtn').addEventListener('click', () => {
    document.getElementById('wpImportOverlay').classList.remove('show');
  });

  // ESC closes any open overlay
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('editorSaveOverlay').classList.contains('show'))    closeEditorSaveDialog();
    else if (document.getElementById('editorOverlay').classList.contains('show'))   closeEditor();
    else if (document.getElementById('previewOverlay').classList.contains('show'))  closePreview();
    else if (document.getElementById('deleteOverlay').classList.contains('show'))   closeDeleteModal();
    else if (document.getElementById('renameOverlay').classList.contains('show'))   closeRenameModal();
    else if (document.getElementById('usageOverlay').classList.contains('show'))    closeUsagePopup();
    else if (document.getElementById('immichPreviewOverlay').classList.contains('show'))    closeImmichPreview();
    else if (document.getElementById('videoPreviewOverlay').classList.contains('show'))     closeVideoPreview();
    else if (document.getElementById('videoDeleteOverlay').classList.contains('show'))      closeVideoDeleteModal();
    else if (document.getElementById('videoRenameOverlay').classList.contains('show'))      closeVideoRenameModal();
    else if (document.getElementById('fileDeleteOverlay').classList.contains('show'))       closeFileDeleteModal();
    else if (document.getElementById('fileRenameOverlay').classList.contains('show'))       closeFileRenameModal();
    else if (document.getElementById('excerptOverlay').classList.contains('show'))          closeExcerptDialog();
    else if (document.getElementById('bulkExcerptOverlay').classList.contains('show'))      closeBulkExcerptDialog();
    else if (document.getElementById('improveOverlay').classList.contains('show'))          closeImproveDialog();
    else if (document.getElementById('createFromImagesOverlay').classList.contains('show')) closeCreateFromImagesDialog();
    else if (document.getElementById('wpImportOverlay').classList.contains('show') &&
             document.getElementById('wpImportDoneBtn').style.display !== 'none')
      document.getElementById('wpImportOverlay').classList.remove('show');
  });
}

// ── API helper ──────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    toast('Session expired – please log in again.', 'error');
    setTimeout(() => { SS.clear(); showLoginPage(); }, 1500);
    throw new Error('Unauthorized');
  }
  return res;
}

// ── Toast ───────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const c  = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

// ── Login ───────────────────────────────────────────────────────────────────
async function handleLogin() {
  const apiKey = document.getElementById('inputApiKey').value.trim();
  const errEl  = document.getElementById('loginError');
  const btn    = document.getElementById('connectBtn');
  errEl.textContent = '';

  if (!apiKey)   { errEl.textContent = 'Please enter your Admin API Key.'; return; }
  if (!/^[a-f0-9]+:[a-f0-9]+$/i.test(apiKey)) { errEl.textContent = 'Key format should be id:secret (hex values).'; return; }

  btn.disabled    = true;
  btn.textContent = 'Connecting…';

  try {
    const res  = await fetch('/api/auth/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      state.apiKey = apiKey;
      SS.set('apiKey', apiKey);
      showApp();
    } else {
      errEl.textContent = data.error || 'Invalid API Key';
    }
  } catch {
    errEl.textContent = 'Connection failed.';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Connect';
  }
}

// ── Media loading ───────────────────────────────────────────────────────────
async function loadMedia() {
  showMediaLoading(true);
  state.allImages = [];

  try {
    const res    = await api('/api/media');
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
    const data = await res.json();
    state.allImages = data.images || [];
    // Show/hide filesystem-not-mounted banner
    const banner = document.getElementById('fsMountBanner');
    if (banner) banner.style.display = data.fsMounted === false ? 'block' : 'none';
    applyFilterSort();
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Failed to load media: ' + e.message, 'error');
  } finally {
    showMediaLoading(false);
  }
}

function showMediaLoading(on) {
  document.getElementById('mediaLoading').style.display = on ? 'flex' : 'none';
  document.getElementById('mediaGrid').style.display    = on ? 'none' : 'grid';
}

function applyListFilterSort(allItems, searchInputId, sortSelectId, nameKey, renderFn) {
  const q    = document.getElementById(searchInputId)?.value.toLowerCase() || '';
  const sort = document.getElementById(sortSelectId)?.value || 'newest';

  let items = allItems.filter(i => (i[nameKey] || '').toLowerCase().includes(q));

  items.sort((a, b) => {
    if (sort === 'newest')   return new Date(b.created_at || b.mtime) - new Date(a.created_at || a.mtime);
    if (sort === 'oldest')   return new Date(a.created_at || a.mtime) - new Date(b.created_at || b.mtime);
    if (sort === 'filename') return (a[nameKey]||'').localeCompare(b[nameKey]||'');
    if (sort === 'largest')  return (b.size||0) - (a.size||0);
    return 0;
  });

  renderFn(items);
}

function applyFilterSort() {
  applyListFilterSort(state.allImages, 'searchInput', 'sortSelect', 'filename',
    items => { state.filteredImages = items; renderGrid(); });
}

// ── Posts cache ─────────────────────────────────────────────────────────────
async function getPostsCache() {
  const TTL = 2 * 60 * 1000;
  if (state.postsCache && Date.now() - state.postsCacheTime < TTL) return state.postsCache;
  try {
    const [postsRes, tagsRes, usersRes] = await Promise.all([
      api('/api/posts/all'),
      api('/api/tags/all'),
      api('/api/users/all'),
    ]);
    const postsData  = postsRes.ok  ? await postsRes.json()  : { posts: [], pages: [] };
    const tagsData   = tagsRes.ok   ? await tagsRes.json()   : { tags: [] };
    const usersData  = usersRes.ok  ? await usersRes.json()  : { users: [] };
    state.postsCache     = { ...postsData, tags: tagsData.tags || [], users: usersData.users || [] };
    state.postsCacheTime = Date.now();
    return state.postsCache;
  } catch {
    return { posts: [], pages: [], tags: [], users: [] };
  }
}

function findImageUsage(imageUrl, postsData) {
  const posts  = [...(postsData.posts || []), ...(postsData.pages || [])];
  const tags   = postsData.tags  || [];
  const users  = postsData.users || [];
  const usedInPosts = posts.filter(p =>
    [p.html, p.lexical, p.feature_image, p.og_image, p.twitter_image].some(f => f && f.includes(imageUrl))
  );
  const usedInTags = tags.filter(t =>
    [t.feature_image, t.og_image, t.twitter_image].some(f => f && f.includes(imageUrl))
  );
  const usedInUsers = users.filter(u =>
    [u.profile_image, u.cover_image].some(f => f && f.includes(imageUrl))
  );
  return [...usedInPosts, ...usedInTags, ...usedInUsers];
}

// ── Render grid ─────────────────────────────────────────────────────────────
function renderGrid() {
  const grid  = document.getElementById('mediaGrid');
  const empty = document.getElementById('mediaEmpty');
  document.getElementById('mediaCount').textContent =
    `${state.filteredImages.length} image${state.filteredImages.length !== 1 ? 's' : ''}`;

  if (state.filteredImages.length === 0) {
    grid.style.display  = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  grid.style.display  = 'grid';
  grid.innerHTML = '';

  state.filteredImages.forEach(img => grid.appendChild(buildImageCard(img)));

  ensureUsageBadges();
}

function ensureUsageBadges() {
  if (state.postsCache) applyUsageBadges();
  else getPostsCache().then(() => applyUsageBadges());
}
function applyUsageBadges() {
  if (!state.postsCache) return;
  document.querySelectorAll('[data-media-url]').forEach(card => {
    const url  = card.dataset.mediaUrl;
    const used = findImageUsage(url, state.postsCache);
    const badge = card.querySelector('.usage-badge');
    if (!badge) return;
    if (used.length > 0) {
      const postCount = used.filter(u => u.type !== 'tag' && u.type !== 'user').length;
      const tagCount  = used.filter(u => u.type === 'tag').length;
      const userCount = used.filter(u => u.type === 'user').length;
      const parts = [];
      if (postCount > 0) parts.push(`${postCount} post${postCount > 1 ? 's' : ''}`);
      if (tagCount  > 0) parts.push(`${tagCount} tag${tagCount > 1 ? 's' : ''}`);
      if (userCount > 0) parts.push(`${userCount} author${userCount > 1 ? 's' : ''}`);
      badge.className   = 'usage-badge used';
      badge.textContent = `Used in ${parts.join(' & ')}`;
      badge.title       = 'Click to see details';
      badge.onclick = (e) => { e.stopPropagation(); openUsagePopup(badge.textContent, used); };
    } else {
      badge.className   = 'usage-badge unused';
      badge.textContent = 'Not used anywhere';
      badge.title       = '';
      badge.onclick     = null;
    }
  });
}

function buildImageCard(img) {
  const url      = img.url || '';
  const filename = img.filename || url.split('/').pop() || 'unknown';
  const date     = img.created_at ? new Date(img.created_at).toLocaleDateString() : '';
  const size     = img.size ? formatBytes(img.size) : '';

  const card = document.createElement('div');
  card.className    = 'image-card';
  card.dataset.mediaUrl = url;
  card.dataset.imgId  = img.id || '';

  card.innerHTML = `
    <div class="image-thumb-wrap">
      <div class="card-select-wrap"><input type="checkbox" class="card-checkbox" title="Select image"></div>
      <img class="image-thumb" src="${escapeHtml(url)}" alt="${escapeHtml(filename)}" loading="lazy">
    </div>
    <div class="image-card-body">
      <div class="image-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
      <div class="image-meta"><span>${date}</span><span>${size}</span></div>
      <span class="usage-badge" style="margin-top:2px">&#8230;</span>
    </div>
    <div class="card-actions">
      <button class="card-btn card-btn-copy" data-action="copy-url">&#128279; URL</button>
      <button class="card-btn card-btn-copy" data-action="copy-md">Md</button>
      <button class="card-btn card-btn-copy" data-action="copy-html">HTML</button>
      <button class="card-btn card-btn-rename" data-action="rename">&#10002; Rename</button>
      <button class="card-btn card-btn-delete" data-action="delete">&#128465; Delete</button>
    </div>
  `;

  card.addEventListener('click', () => {
    openPreview(img);
  });
  card.querySelector('.card-select-wrap').addEventListener('click', e => e.stopPropagation());
  card.querySelector('.card-checkbox').addEventListener('change', e => {
    toggleCardSelection(card, img, e.target.checked);
  });
  card.querySelectorAll('.card-btn').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); handleCardAction(btn.dataset.action, img); })
  );
  return card;
}

function handleCardAction(action, img) {
  const url      = img.url || '';
  const filename = img.filename || url.split('/').pop() || 'image';
  switch (action) {
    case 'copy-url':   copyText(url);                              toast('URL copied!',      'success'); break;
    case 'copy-md':    copyText(`![${filename}](${url})`);         toast('Markdown copied!', 'success'); break;
    case 'copy-html':  copyText(`<img src="${url}" alt="${filename}">`); toast('HTML copied!', 'success'); break;
    case 'rename':     openRenameModal(img); break;
    case 'delete':     openDeleteModal(img); break;
  }
}

// ── Usage popup ─────────────────────────────────────────────────────────────
function openUsagePopup(title, usedIn) {
  document.getElementById('usagePopupTitle').textContent = title;
  const ul = document.getElementById('usagePopupList');
  ul.innerHTML = usedIn.map(p => {
    const label = p.type === 'tag' ? ` <em style="font-size:11px;color:var(--text-muted)">(tag)</em>` : '';
    return `<li><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.name || p.title)}</a>${label}</li>`;
  }).join('');
  document.getElementById('usageOverlay').classList.add('show');
}
function closeUsagePopup() { document.getElementById('usageOverlay').classList.remove('show'); }

// ── Preview overlay (shared for images, videos, files) ───────────────────────
function openPreview(img) { openMediaPreview(img, 'image'); }

function openMediaPreview(item, type) {
  const url  = item.url || '';
  const name = item.filename || item.name || url.split('/').pop() || 'unknown';
  const date = item.created_at
    ? new Date(item.created_at).toLocaleString()
    : (item.mtime ? new Date(item.mtime).toLocaleString() : 'Unknown');
  const size = item.size ? formatBytes(item.size) : 'Unknown';

  // Left pane
  const imgWrap = document.getElementById('previewImgWrap');
  if (type === 'image') {
    state.currentPreviewImage = item;
    imgWrap.innerHTML = `<img id="previewImg" src="${escapeHtml(url)}" alt="${escapeHtml(name)}">`;
  } else if (type === 'video') {
    state.videoPreviewTarget = item;
    imgWrap.innerHTML = `<video id="previewVideo" controls style="max-width:100%;max-height:70vh;border-radius:6px;background:#000;display:block"
      src="${escapeHtml(url)}"></video>`;
  } else {
    const ext = name.split('.').pop().toLowerCase();
    imgWrap.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px">
      <span style="font-size:80px;line-height:1">${getFileIcon(ext)}</span>
      <span style="font-size:13px;font-weight:700;letter-spacing:.06em;padding:3px 10px;border-radius:4px;background:var(--surface3);color:var(--text-muted)">${escapeHtml(ext.toUpperCase())}</span>
    </div>`;
  }

  const mdLabel   = type === 'image' ? `![${name}](${url})`           : `[${name}](${url})`;
  const htmlLabel = type === 'image' ? `<img src="${url}" alt="${name}">` :
                    type === 'video' ? `<video src="${url}" controls></video>` :
                                      `<a href="${url}">${name}</a>`;

  document.getElementById('previewMeta').innerHTML = `
    <div class="preview-close-wrap"><button class="close-btn" onclick="closePreview()">&#10005;</button></div>
    <div class="preview-filename">${escapeHtml(name)}</div>
    <div class="meta-row"><div class="meta-label">Date</div><div class="meta-value">${date}</div></div>
    <div class="meta-row"><div class="meta-label">Size</div><div class="meta-value">${size}</div></div>
    ${type === 'image' && item.width && item.height
      ? `<div class="meta-row"><div class="meta-label">Dimensions</div><div class="meta-value">${item.width} &times; ${item.height} px</div></div>` : ''}
    <div class="meta-row"><div class="meta-label">URL</div><a class="meta-url" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>
    <div class="meta-row" id="previewUsageRow"><div class="meta-label">Usage</div><div class="meta-value"><em style="color:var(--text-muted)">Checking&#8230;</em></div></div>
    <div class="preview-actions">
      <button class="btn btn-ghost preview-action-btn" id="pvCopyUrl">&#128279; Copy URL</button>
      <button class="btn btn-ghost preview-action-btn" id="pvCopyMd">&#128203; Copy ${type === 'image' ? 'Markdown' : 'MD link'}</button>
      <button class="btn btn-ghost preview-action-btn" id="pvCopyHtml">&#128196; Copy HTML</button>
      ${type === 'file' ? `<button class="btn btn-ghost preview-action-btn" id="pvDownload">&#11015; Download</button>` : ''}
      ${type === 'image' ? `<button class="btn btn-ghost preview-action-btn" id="pvEdit">&#9998; Edit</button>` : ''}
      <button class="btn btn-ghost preview-action-btn" id="pvRename">&#10002; Rename</button>
      <button class="btn btn-danger preview-action-btn" id="pvDelete">&#128465; Delete</button>
    </div>
  `;

  document.getElementById('pvCopyUrl').onclick  = () => { copyText(url);       toast('URL copied!',      'success'); };
  document.getElementById('pvCopyMd').onclick   = () => { copyText(mdLabel);   toast('Markdown copied!', 'success'); };
  document.getElementById('pvCopyHtml').onclick = () => { copyText(htmlLabel); toast('HTML copied!',     'success'); };
  if (type === 'file')  document.getElementById('pvDownload').onclick = () => downloadFile(item);
  if (type === 'image') document.getElementById('pvEdit').onclick     = () => { closePreview(); openEditor(item); };
  document.getElementById('pvRename').onclick = () => {
    closePreview();
    if (type === 'image')      openRenameModal(item);
    else if (type === 'video') openVideoRenameModal(item);
    else                       openFileRenameModal(item);
  };
  document.getElementById('pvDelete').onclick = () => {
    closePreview();
    if (type === 'image')      openDeleteModal(item);
    else if (type === 'video') openVideoDeleteModal(item);
    else                       openFileDeleteModal(item);
  };

  document.getElementById('previewOverlay').classList.add('show');

  // Async usage
  getPostsCache().then(postsData => {
    const usageRow = document.getElementById('previewUsageRow');
    if (!usageRow) return;
    const used = findImageUsage(url, postsData);
    const valEl = usageRow.querySelector('.meta-value');
    if (used.length === 0) {
      valEl.innerHTML = '<span style="color:var(--warning)">Not used anywhere</span>';
    } else {
      const postCount = used.filter(u => u.type !== 'tag' && u.type !== 'user').length;
      const tagCount  = used.filter(u => u.type === 'tag').length;
      const userCount = used.filter(u => u.type === 'user').length;
      const parts = [];
      if (postCount > 0) parts.push(`${postCount} post${postCount !== 1 ? 's' : ''}`);
      if (tagCount  > 0) parts.push(`${tagCount} tag${tagCount !== 1 ? 's' : ''}`);
      if (userCount > 0) parts.push(`${userCount} author${userCount !== 1 ? 's' : ''}`);
      const links = used.map(p => {
        const label = p.type === 'tag'  ? ` <em style="font-size:11px;color:var(--text-muted)">(tag)</em>`
                    : p.type === 'user' ? ` <em style="font-size:11px;color:var(--text-muted)">(author)</em>` : '';
        return `<li><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.name || p.title)}</a>${label}</li>`;
      }).join('');
      valEl.innerHTML = `Used in <strong>${parts.join(' and ')}</strong>:<ul class="usage-list" style="margin-top:4px">${links}</ul>`;
    }
  });
}

function closePreview() {
  const vid = document.getElementById('previewVideo');
  if (vid) { vid.pause(); vid.src = ''; }
  document.getElementById('previewOverlay').classList.remove('show');
}

// ── Upload ──────────────────────────────────────────────────────────────────
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  const queue = document.getElementById('uploadQueue');
  queue.innerHTML = '';

  // Duplicate warnings
  for (const f of files) {
    const existing = state.allImages.find(img => (img.filename || img.url.split('/').pop()) === f.name);
    if (existing) {
      const w = document.createElement('div');
      w.className = 'dup-warning';
      w.innerHTML = `⚠ <strong>${escapeHtml(f.name)}</strong> already exists. Uploading will create a duplicate.<br><img src="${escapeHtml(existing.url)}" class="dup-img" alt="existing">`;
      queue.appendChild(w);
    }
  }

  // Build queue items with progress bars
  const items = [];
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `
      <div class="upload-item-row">
        <span class="upload-item-name">${escapeHtml(f.name)}</span>
        <span class="upload-item-status uploading">Uploading…</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    `;
    queue.appendChild(item);
    items.push({ item, name: f.name });
  }

  const formData = new FormData();
  files.forEach(f => formData.append('files', f));

  try {
    const res     = await api('/api/media/upload', { method: 'POST', body: formData });
    const data    = await res.json();
    const results = data.results || [];
    let successCount = 0;

    results.forEach((r, i) => {
      const statusEl   = items[i]?.item.querySelector('.upload-item-status');
      const progressEl = items[i]?.item.querySelector('.progress-bar-fill');
      if (r.success) {
        if (statusEl)   { statusEl.textContent = '✓ Uploaded'; statusEl.className = 'upload-item-status success'; }
        if (progressEl) progressEl.className = 'progress-bar-fill done';
        if (r.image)    state.allImages.unshift(r.image);
        successCount++;
      } else {
        if (statusEl)   { statusEl.textContent = `✗ ${r.error}`; statusEl.className = 'upload-item-status error'; }
        if (progressEl) progressEl.className = 'progress-bar-fill failed';
      }
    });

    if (successCount > 0) {
      toast(`${successCount} file${successCount > 1 ? 's' : ''} uploaded!`, 'success');
      applyFilterSort();
    }
    setTimeout(() => { queue.innerHTML = ''; }, 5000);
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Upload failed.', 'error');
    items.forEach(({ item }) => {
      const s = item.querySelector('.upload-item-status');
      const p = item.querySelector('.progress-bar-fill');
      if (s) { s.textContent = '✗ Failed'; s.className = 'upload-item-status error'; }
      if (p)   p.className = 'progress-bar-fill failed';
    });
  }
}

// ── Video Upload ──────────────────────────────────────────────────────────────
async function handleVideoUpload(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  const queue = document.getElementById('videoUploadQueue');
  queue.innerHTML = '';

  for (const f of files) {
    const existing = state.allVideos.find(v => v.name === f.name);
    if (existing) {
      const w = document.createElement('div');
      w.className = 'dup-warning';
      w.innerHTML = `⚠ <strong>${escapeHtml(f.name)}</strong> already exists. Uploading will create a duplicate.`;
      queue.appendChild(w);
    }
  }

  const items = [];
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `
      <div class="upload-item-row">
        <span class="upload-item-name">${escapeHtml(f.name)}</span>
        <span class="upload-item-status uploading">Uploading…</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    `;
    queue.appendChild(item);
    items.push({ item, name: f.name });
  }

  const formData = new FormData();
  files.forEach(f => formData.append('files', f));

  try {
    const res     = await api('/api/videos/upload', { method: 'POST', body: formData });
    const data    = await res.json();
    const results = data.results || [];
    let successCount = 0;

    results.forEach((r, i) => {
      const statusEl   = items[i]?.item.querySelector('.upload-item-status');
      const progressEl = items[i]?.item.querySelector('.progress-bar-fill');
      if (r.success) {
        if (statusEl)   { statusEl.textContent = '✓ Uploaded'; statusEl.className = 'upload-item-status success'; }
        if (progressEl) progressEl.className = 'progress-bar-fill done';
        if (r.media)    state.allVideos.unshift(r.media);
        successCount++;
      } else {
        if (statusEl)   { statusEl.textContent = `✗ ${r.error}`; statusEl.className = 'upload-item-status error'; }
        if (progressEl) progressEl.className = 'progress-bar-fill failed';
      }
    });

    if (successCount > 0) {
      toast(`${successCount} video${successCount > 1 ? 's' : ''} uploaded!`, 'success');
      applyVideoFilterSort();
    }
    setTimeout(() => { queue.innerHTML = ''; }, 5000);
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Upload failed.', 'error');
    items.forEach(({ item }) => {
      const s = item.querySelector('.upload-item-status');
      const p = item.querySelector('.progress-bar-fill');
      if (s) { s.textContent = '✗ Failed'; s.className = 'upload-item-status error'; }
      if (p)   p.className = 'progress-bar-fill failed';
    });
  }
}

// ── File Attachment Upload ────────────────────────────────────────────────────
async function handleFileUpload(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  const queue = document.getElementById('fileUploadQueue');
  queue.innerHTML = '';

  for (const f of files) {
    const existing = state.allFiles.find(v => v.name === f.name);
    if (existing) {
      const w = document.createElement('div');
      w.className = 'dup-warning';
      w.innerHTML = `⚠ <strong>${escapeHtml(f.name)}</strong> already exists. Uploading will create a duplicate.`;
      queue.appendChild(w);
    }
  }

  const items = [];
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `
      <div class="upload-item-row">
        <span class="upload-item-name">${escapeHtml(f.name)}</span>
        <span class="upload-item-status uploading">Uploading…</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    `;
    queue.appendChild(item);
    items.push({ item, name: f.name });
  }

  const formData = new FormData();
  files.forEach(f => formData.append('files', f));

  try {
    const res     = await api('/api/files/upload', { method: 'POST', body: formData });
    const data    = await res.json();
    const results = data.results || [];
    let successCount = 0;

    results.forEach((r, i) => {
      const statusEl   = items[i]?.item.querySelector('.upload-item-status');
      const progressEl = items[i]?.item.querySelector('.progress-bar-fill');
      if (r.success) {
        if (statusEl)   { statusEl.textContent = '✓ Uploaded'; statusEl.className = 'upload-item-status success'; }
        if (progressEl) progressEl.className = 'progress-bar-fill done';
        if (r.attachment) state.allFiles.unshift(r.attachment);
        successCount++;
      } else {
        if (statusEl)   { statusEl.textContent = `✗ ${r.error}`; statusEl.className = 'upload-item-status error'; }
        if (progressEl) progressEl.className = 'progress-bar-fill failed';
      }
    });

    if (successCount > 0) {
      toast(`${successCount} file${successCount > 1 ? 's' : ''} uploaded!`, 'success');
      applyFileFilterSort();
    }
    setTimeout(() => { queue.innerHTML = ''; }, 5000);
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Upload failed.', 'error');
    items.forEach(({ item }) => {
      const s = item.querySelector('.upload-item-status');
      const p = item.querySelector('.progress-bar-fill');
      if (s) { s.textContent = '✗ Failed'; s.className = 'upload-item-status error'; }
      if (p)   p.className = 'progress-bar-fill failed';
    });
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────
function createModal(ids, handlers) {
  const _state = { target: null, loading: false };
  function open(t) {
    _state.target = t;
    handlers.onOpen?.(t);
    document.getElementById(ids.overlay)?.classList.add('show');
  }
  function close() {
    _state.target = null;
    handlers.onClose?.();
    document.getElementById(ids.overlay)?.classList.remove('show');
  }
  async function confirm() {
    if (_state.loading) return;
    _state.loading = true;
    const btn = document.getElementById(ids.confirmBtn);
    if (btn) btn.disabled = true;
    try {
      await handlers.onConfirm(_state.target);
      close();
    } catch (err) {
      if (err?.message !== 'Unauthorized') toast(err.message || 'Operation failed', 'error');
    } finally {
      _state.loading = false;
      if (btn) btn.disabled = false;
    }
  }
  return { open, close, confirm, getTarget: () => _state.target };
}
const deleteModal = createModal(
  { overlay: 'deleteOverlay', confirmBtn: 'deleteConfirmBtn' },
  {
    onOpen(img) {
      document.getElementById('deleteFilename').textContent = img.filename || img.url.split('/').pop();
      const warn = document.getElementById('deleteUsageWarning');
      warn.style.display = 'none';
      if (state.postsCache) {
        const used = findImageUsage(img.url, state.postsCache);
        if (used.length > 0) {
          const postCount = used.filter(u => u.type !== 'tag' && u.type !== 'user').length;
          const tagCount  = used.filter(u => u.type === 'tag').length;
          const userCount = used.filter(u => u.type === 'user').length;
          const parts = [];
          if (postCount > 0) parts.push(`${postCount} post(s)`);
          if (tagCount  > 0) parts.push(`${tagCount} tag(s)`);
          if (userCount > 0) parts.push(`${userCount} author(s)`);
          warn.style.display = 'block';
          warn.textContent   = `⚠ This image is referenced in ${parts.join(' and ')}. Deleting it will break those references.`;
        }
      }
    },
    async onConfirm(img) {
      const btn = document.getElementById('deleteConfirmBtn');
      btn.textContent = 'Deleting…';
      try {
        const params = new URLSearchParams({ imageUrl: img.url });
        const res    = await api(`/api/media/file?${params}`, { method: 'DELETE' });
        const data   = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Delete failed');
        state.allImages = state.allImages.filter(i => i.url !== img.url);
        applyFilterSort();
        toast(data.fsDeleted ? 'Image deleted from Ghost and removed from disk.' : 'Image deleted from Ghost.', 'success');
      } finally {
        btn.textContent = 'Delete';
      }
    },
  }
);
function openDeleteModal(img)  { deleteModal.open(img); }
function closeDeleteModal()    { deleteModal.close(); }
async function confirmDelete() { await deleteModal.confirm(); }

async function openRenameModal(img) {
  state.renameTarget = { image: img, usedIn: [] };
  const filename = img.filename || img.url.split('/').pop() || '';

  document.getElementById('renameCurrentName').textContent = filename;
  document.getElementById('renameInput').value             = filename;
  document.getElementById('renameError').textContent       = '';
  document.getElementById('renameFsNote').innerHTML        = state.hasFs
    ? '<span style="color:var(--success)">✓ Filesystem mounted – file will be physically renamed on disk</span>'
    : '<span style="color:var(--warning)">⚠ No filesystem mount – only post references will be updated</span>';
  document.getElementById('renameUsageSection').style.display = 'none';
  document.getElementById('renameScanning').style.display     = 'flex';
  document.getElementById('renameConfirmBtn').disabled    = true;
  document.getElementById('renameConfirmBtn').textContent = state.hasFs ? 'Rename File & Update Posts' : 'Rename & Update Posts';
  document.getElementById('renameOverlay').classList.add('show');

  try {
    const postsData = await getPostsCache();
    const used      = findImageUsage(img.url, postsData);
    state.renameTarget.usedIn = used;

    document.getElementById('renameScanning').style.display  = 'none';
    document.getElementById('renameConfirmBtn').disabled     = false;

    if (used.length > 0) {
      const rPostCount = used.filter(u => u.type !== 'tag' && u.type !== 'user').length;
      const rTagCount  = used.filter(u => u.type === 'tag').length;
      const rUserCount = used.filter(u => u.type === 'user').length;
      const rParts = [];
      if (rPostCount > 0) rParts.push(`${rPostCount} post(s)`);
      if (rTagCount  > 0) rParts.push(`${rTagCount} tag(s)`);
      if (rUserCount > 0) rParts.push(`${rUserCount} author(s)`);
      document.getElementById('renameUsageSummary').textContent = `This image is used in ${rParts.join(' and ')} – all references will be updated:`;
      document.getElementById('renameUsageList').innerHTML = used
        .map(p => {
          const label = p.type === 'tag'  ? ` <em style="font-size:11px;color:var(--text-muted)">(tag)</em>`
                      : p.type === 'user' ? ` <em style="font-size:11px;color:var(--text-muted)">(author)</em>`
                      : '';
          return `<li><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.name || p.title)}</a>${label}</li>`;
        })
        .join('');
      document.getElementById('renameUsageSection').style.display = 'block';
    } else {
      document.getElementById('renameUsageSummary').textContent = 'This image is not used anywhere.';
      document.getElementById('renameUsageSection').style.display = 'block';
    }
  } catch {
    document.getElementById('renameScanning').style.display  = 'none';
    document.getElementById('renameConfirmBtn').disabled     = false;
  }

  document.getElementById('renameInput').focus();
  document.getElementById('renameInput').select();
}

function closeRenameModal() {
  document.getElementById('renameOverlay').classList.remove('show');
  state.renameTarget = null;
}

async function confirmRename() {
  const target = state.renameTarget;
  if (!target) return;
  const img     = target.image;
  const newName = document.getElementById('renameInput').value.trim();
  const errEl   = document.getElementById('renameError');
  errEl.textContent = '';

  const oldFilename = img.filename || img.url.split('/').pop() || '';
  if (!newName)              { errEl.textContent = 'Please enter a new filename.'; return; }
  if (newName === oldFilename){ errEl.textContent = 'New name is the same as current.'; return; }
  const dup = state.allImages.find(i => i.id !== img.id && (i.filename || i.url.split('/').pop()) === newName);
  if (dup) { errEl.textContent = 'A file with that name already exists.'; return; }

  const btn = document.getElementById('renameConfirmBtn');
  btn.disabled = true; btn.textContent = 'Updating…';

  const oldUrl = img.url;
  let   newUrl;

  // Physical file rename if filesystem is mounted in container
  if (state.hasFs) {
    try {
      const r = await api('/api/media/rename', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageUrl: oldUrl, newFilename: newName }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) {
        errEl.textContent = d.error || 'Physical rename failed.';
        btn.disabled = false; btn.textContent = 'Rename File & Update Posts';
        return;
      }
      newUrl = d.newUrl;
    } catch (e) {
      if (e.message !== 'Unauthorized') errEl.textContent = 'Rename failed.';
      btn.disabled = false; btn.textContent = 'Rename File & Update Posts';
      return;
    }
  } else {
    newUrl = oldUrl.replace(/[^/]+$/, newName);
  }

  const usedIn        = target.usedIn;
  let   updatedCount  = 0;
  const failedTitles  = [];

  for (const post of usedIn) {
    try {
      const params = new URLSearchParams();
      if (post.type === 'tag') {
        const updated = buildTagUpdate(post, oldUrl, newUrl);
        const res     = await api(`/api/tags/${post.id}?${params}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tags: [updated] }),
        });
        if (res.ok) updatedCount++;
        else        failedTitles.push(post.name);
      } else if (post.type === 'user') {
        const updated = buildUserUpdate(post, oldUrl, newUrl);
        const res     = await api(`/api/users/${post.id}?${params}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ users: [updated] }),
        });
        if (res.ok) updatedCount++;
        else        failedTitles.push(post.name);
      } else {
        const type    = post.type === 'page' ? 'pages' : 'posts';
        const updated = buildPostUpdate(post, oldUrl, newUrl);
        const res     = await api(`/api/posts/${type}/${post.id}?${params}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ [type]: [updated] }),
        });
        if (res.ok) updatedCount++;
        else        failedTitles.push(post.title);
      }
    } catch {
      failedTitles.push(post.name || post.title);
    }
  }

  state.postsCache = null; // invalidate

  if (state.hasFs) {
    const postMsg = usedIn.length > 0
      ? ` + ${updatedCount} of ${usedIn.length} post(s) updated`
      : '';
    const warnMsg = failedTitles.length > 0 ? ` (${failedTitles.length} failed)` : '';
    toast(`✓ File renamed on disk${postMsg}${warnMsg}.`, failedTitles.length > 0 ? 'warning' : 'success', 6000);
    const localImg = state.allImages.find(i => i.id === img.id);
    if (localImg) { localImg.url = newUrl; localImg.filename = newName; }
    applyFilterSort();
  } else {
    if (failedTitles.length > 0 && updatedCount === 0) {
      toast('Failed to update posts. No changes were saved.', 'error');
    } else if (failedTitles.length > 0) {
      toast(`${updatedCount} post(s) updated, ${failedTitles.length} failed.`, 'warning', 6000);
    } else if (usedIn.length > 0) {
      toast(`✓ ${usedIn.length} post(s) updated. Note: physical rename requires filesystem mount.`, 'success', 7000);
    } else {
      toast('No posts used this image. Physical rename requires filesystem mount.', 'info', 5000);
    }
  }

  btn.disabled = false; btn.textContent = state.hasFs ? 'Rename File & Update Posts' : 'Rename & Update Posts';
  closeRenameModal();
}

function buildTagUpdate(tag, oldUrl, newUrl) {
  const u = { id: tag.id, updated_at: tag.updated_at };
  if (tag.feature_image && tag.feature_image.includes(oldUrl)) u.feature_image = tag.feature_image.split(oldUrl).join(newUrl);
  if (tag.og_image      && tag.og_image.includes(oldUrl))      u.og_image      = tag.og_image.split(oldUrl).join(newUrl);
  if (tag.twitter_image && tag.twitter_image.includes(oldUrl)) u.twitter_image = tag.twitter_image.split(oldUrl).join(newUrl);
  return u;
}

function buildUserUpdate(user, oldUrl, newUrl) {
  const u = { id: user.id, updated_at: user.updated_at };
  if (user.profile_image && user.profile_image.includes(oldUrl)) u.profile_image = user.profile_image.split(oldUrl).join(newUrl);
  if (user.cover_image   && user.cover_image.includes(oldUrl))   u.cover_image   = user.cover_image.split(oldUrl).join(newUrl);
  return u;
}

function buildPostUpdate(post, oldUrl, newUrl) {
  const u = { id: post.id, updated_at: post.updated_at };

  // Lexical: parse the JSON tree, replace exact URL matches node-by-node,
  // then re-serialize. Never send 'html' — it is a derived read-only field
  // and sending it alongside lexical can strip images in Ghost 5+.
  if (post.lexical && post.lexical.includes(oldUrl)) {
    try {
      const doc = JSON.parse(post.lexical);
      function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
          if (typeof node[key] === 'string' && node[key] === oldUrl) {
            node[key] = newUrl;
          } else {
            walk(node[key]);
          }
        }
      }
      walk(doc);
      u.lexical = JSON.stringify(doc);
    } catch {
      // Lexical JSON parse failure — skip to avoid corrupting post content
    }
  }

  if (post.feature_image && post.feature_image.includes(oldUrl)) u.feature_image = post.feature_image.split(oldUrl).join(newUrl);
  if (post.og_image      && post.og_image.includes(oldUrl))      u.og_image      = post.og_image.split(oldUrl).join(newUrl);
  if (post.twitter_image && post.twitter_image.includes(oldUrl)) u.twitter_image = post.twitter_image.split(oldUrl).join(newUrl);
  return u;
}

// ── Settings ────────────────────────────────────────────────────────────────
async function saveGhostSettings() {
  const apiKey = document.getElementById('settingsApiKey').value.trim();
  if (!apiKey) { toast('Please enter an API Key.', 'warning'); return; }

  const btn = document.getElementById('saveGhostSettings');
  btn.disabled = true; btn.textContent = 'Validating…';

  try {
    const res  = await fetch('/api/auth/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      state.apiKey = apiKey;
      SS.set('apiKey', apiKey);
      state.postsCache = null;
      loadMedia();
      toast('API Key saved!', 'success');
    } else {
      toast(data.error || 'Invalid API Key', 'error');
    }
  } catch { toast('Connection failed.', 'error'); }
  finally  { btn.disabled = false; btn.textContent = 'Save & Reconnect'; }
}

function saveImmichSettings() {
  const immichUrl = document.getElementById('settingsImmichUrl').value.trim().replace(/\/$/, '');
  const immichKey = document.getElementById('settingsImmichKey').value.trim();
  state.immichUrl = immichUrl;
  state.immichKey = immichKey;
  SS.set('immichUrl', immichUrl);
  SS.set('immichKey', immichKey);
  checkImmichConfig();
  toast('Immich settings saved!', 'success');
}

// ── Immich ──────────────────────────────────────────────────────────────────
function checkImmichConfig() {
  const ok = state.immichUrl && state.immichKey;
  document.getElementById('immichNotConfigured').style.display = ok ? 'none' : 'flex';
  document.getElementById('immichContent').style.display       = ok ? 'flex' : 'none';
}

function initImmichTab() {
  checkImmichConfig();
  if (!state.immichUrl || !state.immichKey) return;
  showAlbumsView();
  loadAlbums();
}

function showAlbumsView() {
  document.getElementById('immichAlbumsView').style.display  = 'block';
  document.getElementById('immichPhotosView').style.display  = 'none';
}

async function loadAlbums() {
  const grid  = document.getElementById('albumGrid');
  const load  = document.getElementById('albumLoading');
  const empty = document.getElementById('albumEmpty');
  grid.innerHTML = '';
  load.style.display  = 'flex';
  empty.style.display = 'none';

  try {
    const params = new URLSearchParams({ immichUrl: state.immichUrl, immichKey: state.immichKey });
    const res    = await api(`/api/immich/albums?${params}`);
    const data   = await res.json();
    const albums = Array.isArray(data) ? data : [];

    const q        = document.getElementById('immichSearch').value.toLowerCase();
    const filtered = q ? albums.filter(a => a.albumName?.toLowerCase().includes(q)) : albums;

    if (filtered.length === 0) { empty.style.display = 'flex'; return; }

    filtered.forEach(album => {
      const card     = document.createElement('div');
      card.className = 'album-card';
      const cover    = album.albumThumbnailAssetId;
      const thumbUrl = cover
        ? `/api/immich/thumbnail/${cover}?${new URLSearchParams({ immichUrl: state.immichUrl, immichKey: state.immichKey })}`
        : null;
      card.innerHTML  = thumbUrl
        ? `<img src="${escapeHtml(thumbUrl)}" class="album-cover" alt="" loading="lazy">`
        : `<div class="album-cover-placeholder">📷</div>`;
      card.innerHTML += `<div class="album-info"><div class="album-name">${escapeHtml(album.albumName || 'Untitled')}</div><div class="album-count">${album.assetCount || 0} photos</div></div>`;
      card.addEventListener('click', () => loadAlbumPhotos(album.id, album.albumName));
      grid.appendChild(card);
    });
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Failed to load albums.', 'error');
  } finally {
    load.style.display = 'none';
  }
}

async function loadAlbumPhotos(albumId) {
  document.getElementById('immichAlbumsView').style.display = 'none';
  const photosView = document.getElementById('immichPhotosView');
  photosView.style.display = 'flex';
  const grid = document.getElementById('photoGrid');
  const load = document.getElementById('photoLoading');
  grid.innerHTML = '';
  load.style.display = 'flex';

  try {
    const params = new URLSearchParams({ immichUrl: state.immichUrl, immichKey: state.immichKey });
    const res    = await api(`/api/immich/albums/${albumId}?${params}`);
    const data   = await res.json();
    const assets = data.assets || [];

    const q        = document.getElementById('immichSearch').value.toLowerCase();
    const filtered = q ? assets.filter(a =>
      (a.originalFileName || '').toLowerCase().includes(q) ||
      (a.fileCreatedAt   || '').includes(q)
    ) : assets;

    filtered.forEach(asset => {
      const thumbUrl = `/api/immich/thumbnail/${asset.id}?${new URLSearchParams({ immichUrl: state.immichUrl, immichKey: state.immichKey })}`;
      const card     = document.createElement('div');
      card.className = 'immich-photo';
      card.innerHTML = `<img src="${escapeHtml(thumbUrl)}" loading="lazy" alt=""><div class="immich-photo-info">${escapeHtml(asset.originalFileName || asset.id)}</div>`;
      card.addEventListener('click', () => openImmichPreview(asset));
      grid.appendChild(card);
    });
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Failed to load photos.', 'error');
  } finally {
    load.style.display = 'none';
  }
}

function openImmichPreview(asset) {
  state.currentImmichAsset = asset;
  const thumbUrl = `/api/immich/thumbnail/${asset.id}?${new URLSearchParams({ immichUrl: state.immichUrl, immichKey: state.immichKey })}`;
  document.getElementById('immichPreviewImg').src = thumbUrl;
  const date = asset.fileCreatedAt ? new Date(asset.fileCreatedAt).toLocaleString() : 'Unknown';
  document.getElementById('immichPreviewMeta').innerHTML = `
    <div class="meta-row" style="margin-bottom:8px"><div class="meta-label">Filename</div><div class="meta-value" style="font-weight:600">${escapeHtml(asset.originalFileName || asset.id)}</div></div>
    <div class="meta-row"><div class="meta-label">Date</div><div class="meta-value">${date}</div></div>
    <div class="meta-row"><div class="meta-label">Type</div><div class="meta-value">${escapeHtml(asset.originalMimeType || asset.type || '')}</div></div>
  `;
  document.getElementById('immichPreviewOverlay').classList.add('show');
}

function closeImmichPreview() {
  document.getElementById('immichPreviewOverlay').classList.remove('show');
  state.currentImmichAsset = null;
}

function isVideoAsset(asset) {
  return asset.type === 'VIDEO' ||
    ['mp4', 'mov', 'webm', 'm4v'].includes(
      asset.originalFileName?.split('.').pop()?.toLowerCase()
    );
}

async function handleUseInGhost() {
  const asset = state.currentImmichAsset;
  if (!asset) return;
  const btn = document.getElementById('useInGhostBtn');
  btn.disabled = true; btn.textContent = 'Transferring…';
  try {
    if (isVideoAsset(asset)) {
      const res = await api('/api/immich/import-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          immichUrl:  state.immichUrl,
          immichKey:  state.immichKey,
          assetId:    asset.id,
          filename:   asset.originalFileName || `immich-${asset.id}.mp4`,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const ghostUrl = data.media?.url || '';
        copyText(ghostUrl);
        toast(`✓ Uploaded to Ghost! URL copied to clipboard.`, 'success', 6000);
        if (data.media) { state.allVideos.unshift(data.media); applyVideoFilterSort(); }
        closeImmichPreview();
      } else {
        toast(data.error || 'Transfer failed', 'error');
      }
    } else {
      const res = await api('/api/immich/use-in-ghost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          immichUrl:  state.immichUrl,
          immichKey:  state.immichKey,
          assetId:    asset.id,
          filename:   asset.originalFileName || `immich-${asset.id}.jpg`,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const ghostUrl = data.image?.url || '';
        copyText(ghostUrl);
        toast(`✓ Uploaded to Ghost! URL copied to clipboard.`, 'success', 6000);
        if (data.image) { state.allImages.unshift(data.image); applyFilterSort(); }
        closeImmichPreview();
      } else {
        toast(data.error || 'Transfer failed', 'error');
      }
    }
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Transfer failed.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = '⬆ Use in Ghost';
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text; el.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(el); el.focus(); el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
}

function formatBytes(b) {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Image Editor ───────────────────────────────────────────────────────────
function openEditor(img) {
  if (!window.FilerobotImageEditor) {
    toast('Image editor not loaded. Check your internet connection.', 'error');
    return;
  }
  state.editorImage  = img;
  state.editorResult = null;
  const mount = document.getElementById('editorMount');
  mount.innerHTML = '';
  document.getElementById('editorOverlay').classList.add('show');

  const { TABS, TOOLS } = window.FilerobotImageEditor;
  const editor = new window.FilerobotImageEditor(mount, {
    source: `/api/media/proxy?url=${encodeURIComponent(img.url)}`,
    onSave(editedImageObject) {
      state.editorResult = editedImageObject;
      closeEditor();
      openEditorSaveDialog();
    },
    onBeforeSave: () => false,
    onClose() { closeEditor(); },
    tabsIds:      [TABS.ADJUST, TABS.FINETUNE, TABS.FILTERS, TABS.ANNOTATE, TABS.RESIZE],
    defaultTabId:  TABS.ADJUST,
    defaultToolId: TOOLS.CROP,
    savingPixelRatio: 4,
    previewPixelRatio: Math.min(window.devicePixelRatio, 2),
    useBackendTranslations: false,
    Crop: { ratio: 'custom', noPresets: true },
    theme: {
      palette: {
        'accent-primary':        '#6c63ff',
        'accent-primary-active': '#857dff',
        'bg-primary-active':     '#6c63ff',
      },
    },
  });
  editor.render();
  state.currentEditor = editor;
}

function closeEditor() {
  document.getElementById('editorOverlay').classList.remove('show');
  if (state.currentEditor) {
    try { state.currentEditor.terminate(); } catch {}
    state.currentEditor = null;
  }
  document.getElementById('editorMount').innerHTML = '';
}

async function openEditorSaveDialog() {
  const img = state.editorImage;
  const base = img.filename.replace(/\.[^.]+$/, '');
  const ext  = (img.filename.match(/\.([^.]+)$/) || ['', 'jpg'])[1].toLowerCase();
  document.getElementById('editorSaveNewFilename').value = `${base}-edited.${ext}`;
  document.getElementById('editorSaveUsageInfo').innerHTML = '<em style="color:var(--text-muted);font-size:13px">Checking usage…</em>';
  selectEditorSaveMode('overwrite');
  document.getElementById('editorSaveConfirmBtn').disabled = false;
  document.getElementById('editorSaveOverlay').classList.add('show');

  const postsData = await getPostsCache();
  const used      = findImageUsage(img.url, postsData);
  state.editorUsedIn = used;
  const infoEl = document.getElementById('editorSaveUsageInfo');
  if (used.length > 0) {
    const postCount = used.filter(u => u.type !== 'tag' && u.type !== 'user').length;
    const tagCount  = used.filter(u => u.type === 'tag').length;
    const userCount = used.filter(u => u.type === 'user').length;
    const parts = [];
    if (postCount > 0) parts.push(`${postCount} post(s)`);
    if (tagCount  > 0) parts.push(`${tagCount} tag(s)`);
    if (userCount > 0) parts.push(`${userCount} author(s)`);
    infoEl.innerHTML = `<span style="color:var(--warning);font-size:13px">⚠ Used in ${parts.join(' and ')} — overwriting replaces it everywhere instantly.</span>`;
  } else {
    infoEl.innerHTML = `<span style="color:var(--text-muted);font-size:13px">Not currently used in any post, tag, or author profile.</span>`;
  }
}

function closeEditorSaveDialog() {
  document.getElementById('editorSaveOverlay').classList.remove('show');
  state.editorResult = null;
  state.editorUsedIn = [];
}

function selectEditorSaveMode(mode) {
  state.editorSaveMode = mode;
  document.getElementById('editorOptA').classList.toggle('selected', mode === 'overwrite');
  document.getElementById('editorOptB').classList.toggle('selected', mode === 'new');
  document.getElementById('editorOptBForm').style.display = mode === 'new' ? 'block' : 'none';
  const btn = document.getElementById('editorSaveConfirmBtn');
  btn.disabled = false;
  btn.textContent = mode === 'overwrite' ? 'Overwrite' : 'Upload & Copy Markdown';
}

function _base64ToBlob(base64, mimeType) {
  const data  = base64.includes(',') ? base64.split(',')[1] : base64;
  const bytes = atob(data);
  const ab    = new ArrayBuffer(bytes.length);
  const ia    = new Uint8Array(ab);
  for (let i = 0; i < bytes.length; i++) ia[i] = bytes.charCodeAt(i);
  return new Blob([ab], { type: mimeType || 'image/jpeg' });
}

async function confirmEditorSave() {
  if (state.editorSaveMode === 'overwrite') await _editorDoOverwrite();
  else await _editorDoSaveAsNew();
}

async function _editorDoOverwrite() {
  const img    = state.editorImage;
  const result = state.editorResult;
  const btn    = document.getElementById('editorSaveConfirmBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const blob = _base64ToBlob(result.imageBase64, result.mimeType);
    const fd   = new FormData();
    fd.append('file', blob, img.filename); // keep original filename
    const params = new URLSearchParams({ imageUrl: img.url });
    const res  = await api(`/api/media/overwrite?${params}`, { method: 'POST', body: fd });
    const data = await res.json();
    if (res.ok && data.success) {
      // Bust browser cache for this image in the grid + preview
      const bust = `${img.url}?t=${Date.now()}`;
      document.querySelectorAll(`img[src^="${CSS.escape ? img.url : img.url}"]`).forEach(el => { el.src = bust; });
      toast('✓ Image overwritten on disk.', 'success');
      closeEditorSaveDialog();
    } else {
      toast(data.error || 'Overwrite failed', 'error');
      btn.disabled = false; btn.textContent = 'Overwrite';
    }
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Overwrite failed.', 'error');
    btn.disabled = false; btn.textContent = 'Overwrite';
  }
}

async function _editorDoSaveAsNew() {
  const result      = state.editorResult;
  const newFilename = document.getElementById('editorSaveNewFilename').value.trim();
  if (!newFilename) { toast('Please enter a filename.', 'warning'); return; }
  if (/[\/\\<>:"|?*]/.test(newFilename)) { toast('Invalid characters in filename.', 'error'); return; }
  const btn = document.getElementById('editorSaveConfirmBtn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const blob = _base64ToBlob(result.imageBase64, result.mimeType);
    const fd   = new FormData();
    fd.append('files', blob, newFilename);
    const res  = await api('/api/media/upload', { method: 'POST', body: fd });
    const data = await res.json();
    const item = data.results?.[0];
    if (item?.success) {
      const newUrl = item.image.url;
      copyText(`![${newFilename}](${newUrl})`);
      toast(`✓ Uploaded! Markdown link copied to clipboard.`, 'success', 7000);
      state.postsCache = null;
      loadMedia();
      closeEditorSaveDialog();
    } else {
      toast(item?.error || 'Upload failed', 'error');
      btn.disabled = false; btn.textContent = 'Upload & Copy Markdown';
    }
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Upload failed.', 'error');
    btn.disabled = false; btn.textContent = 'Upload & Copy Markdown';
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ── Image selection mode ──────────────────────────────────────────────────────
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•


function clearSelection() {
  state.selectedImages = [];
  document.querySelectorAll('.image-card').forEach(c => {
    c.classList.remove('selected');
    const chk = c.querySelector('.card-checkbox');
    if (chk) chk.checked = false;
  });
  _updateSelectionToolbar();
}

function toggleCardSelection(card, img, forceChecked) {
  const idx = state.selectedImages.findIndex(i => i.url === img.url);
  const shouldSelect = forceChecked !== undefined ? forceChecked : idx === -1;
  const chk = card.querySelector('.card-checkbox');

  if (shouldSelect && idx === -1) {
    state.selectedImages.push(img);
    card.classList.add('selected');
    if (chk) chk.checked = true;
  } else if (!shouldSelect && idx !== -1) {
    state.selectedImages.splice(idx, 1);
    card.classList.remove('selected');
    if (chk) chk.checked = false;
  }
  _updateSelectionToolbar();
}

function _updateSelectionToolbar() {
  const n       = state.selectedImages.length;
  const toolbar = document.getElementById('selectionToolbar');
  toolbar.style.display = n > 0 ? 'flex' : 'none';
  document.getElementById('selectionCount').textContent =
    n === 0 ? 'No images selected' : `${n} image${n !== 1 ? 's' : ''} selected`;
  const delBtn = document.getElementById('selectionDeleteBtn');
  delBtn.disabled    = n === 0;
  delBtn.textContent = `🗑 Delete ${n} selected`;
  const insertBtn = document.getElementById('selectionInsertBtn');
  insertBtn.style.display = n === 1 ? 'inline-flex' : 'none';
  insertBtn.disabled      = n !== 1;
  const galleryBtn = document.getElementById('selectionGalleryBtn');
  galleryBtn.style.display = (n >= 2 && n <= 9) ? 'inline-flex' : 'none';
  updateAiPostBadge();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ── Video selection mode ──────────────────────────────────────────────────────

function clearVideoSelection() {
  state.selectedVideos = [];
  document.querySelectorAll('#videoGrid .image-card').forEach(c => {
    c.classList.remove('selected');
    const chk = c.querySelector('.card-checkbox');
    if (chk) chk.checked = false;
  });
  _updateVideoSelectionToolbar();
}

function toggleVideoCardSelection(card, video, forceChecked) {
  const idx = state.selectedVideos.findIndex(v => v.url === video.url);
  const shouldSelect = forceChecked !== undefined ? forceChecked : idx === -1;
  const chk = card.querySelector('.card-checkbox');
  if (shouldSelect && idx === -1) {
    state.selectedVideos.push(video);
    card.classList.add('selected');
    if (chk) chk.checked = true;
  } else if (!shouldSelect && idx !== -1) {
    state.selectedVideos.splice(idx, 1);
    card.classList.remove('selected');
    if (chk) chk.checked = false;
  }
  _updateVideoSelectionToolbar();
}

function _updateVideoSelectionToolbar() {
  const n       = state.selectedVideos.length;
  const toolbar = document.getElementById('videoSelectionToolbar');
  toolbar.style.display = n > 0 ? 'flex' : 'none';
  document.getElementById('videoSelectionCount').textContent =
    n === 0 ? 'No videos selected' : `${n} video${n !== 1 ? 's' : ''} selected`;
  const delBtn = document.getElementById('videoSelectionDeleteBtn');
  delBtn.disabled    = n === 0;
  delBtn.textContent = `🗑 Delete ${n} selected`;
  updateAiPostBadge();
}

// ── Files selection mode ──────────────────────────────────────────────────────

function clearFilesSelection() {
  state.selectedFiles = [];
  document.querySelectorAll('#filesGrid .image-card').forEach(c => {
    c.classList.remove('selected');
    const chk = c.querySelector('.card-checkbox');
    if (chk) chk.checked = false;
  });
  _updateFilesSelectionToolbar();
}

function toggleFileCardSelection(card, file, forceChecked) {
  const idx = state.selectedFiles.findIndex(f => f.url === file.url);
  const shouldSelect = forceChecked !== undefined ? forceChecked : idx === -1;
  const chk = card.querySelector('.card-checkbox');
  if (shouldSelect && idx === -1) {
    state.selectedFiles.push(file);
    card.classList.add('selected');
    if (chk) chk.checked = true;
  } else if (!shouldSelect && idx !== -1) {
    state.selectedFiles.splice(idx, 1);
    card.classList.remove('selected');
    if (chk) chk.checked = false;
  }
  _updateFilesSelectionToolbar();
}

function _updateFilesSelectionToolbar() {
  const n       = state.selectedFiles.length;
  const toolbar = document.getElementById('filesSelectionToolbar');
  toolbar.style.display = n > 0 ? 'flex' : 'none';
  document.getElementById('filesSelectionCount').textContent =
    n === 0 ? 'No files selected' : `${n} file${n !== 1 ? 's' : ''} selected`;
  const delBtn = document.getElementById('filesSelectionDeleteBtn');
  delBtn.disabled    = n === 0;
  delBtn.textContent = `🗑 Delete ${n} selected`;
  updateAiPostBadge();
}

// ── Navbar AI badge counter ──
function updateAiPostBadge() {
  const pdfCount = state.selectedFiles.filter(f => f.url?.toLowerCase().endsWith('.pdf')).length;
  const total = state.selectedImages.length + state.selectedVideos.length + pdfCount;
  const badge = document.getElementById('aiMediaBadge');
  if (!badge) return;
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

// ── Bulk delete ───────────────────────────────────────────────────────────────

let _bulkDeleteState = null; // { items, tab }

function _showBulkDeletePhase(phase) {
  document.getElementById('bulkDeleteConfirmSection').style.display  = phase === 'confirm'  ? '' : 'none';
  document.getElementById('bulkDeleteProgressSection').style.display = phase === 'progress' ? '' : 'none';
  document.getElementById('bulkDeleteSummarySection').style.display  = phase === 'summary'  ? '' : 'none';
  document.getElementById('bulkDeleteCancelBtn').style.display       = phase === 'confirm'  ? 'inline-flex' : 'none';
  document.getElementById('bulkDeleteConfirmBtn').style.display      = phase === 'confirm'  ? 'inline-flex' : 'none';
  document.getElementById('bulkDeleteAbortBtn').style.display        = phase === 'progress' ? 'inline-flex' : 'none';
  document.getElementById('bulkDeleteCloseBtn').style.display        = phase === 'summary'  ? 'inline-flex' : 'none';
}

function closeBulkDeleteModal() {
  document.getElementById('bulkDeleteOverlay').classList.remove('show');
  _bulkDeleteState        = null;
  state.bulkDeleteAbortFlag = false;
}

function executeBulkDelete(items, tab) {
  if (!items.length) return;
  _bulkDeleteState = { items, tab };
  const n         = items.length;
  const typeLabel = tab === 'media' ? 'image' : tab === 'videos' ? 'video' : 'file';

  document.getElementById('bulkDeleteTitle').textContent = `Delete ${n} ${typeLabel}${n !== 1 ? 's' : ''}?`;
  document.getElementById('bulkDeleteBreakdown').innerHTML =
    `<li>${n} ${typeLabel}${n !== 1 ? 's' : ''}</li>`;

  const warn = document.getElementById('bulkDeleteUsageWarning');
  warn.style.display = 'none';
  if (state.postsCache) {
    const anyUsed = items.some(item => findImageUsage(item.url, state.postsCache).length > 0);
    if (anyUsed) warn.style.display = 'block';
  }

  _showBulkDeletePhase('confirm');
  document.getElementById('bulkDeleteOverlay').classList.add('show');
}

async function _runBulkDelete() {
  const { items, tab } = _bulkDeleteState;
  const n = items.length;
  state.bulkDeleteAbortFlag = false;

  _showBulkDeletePhase('progress');

  const progressLabel = document.getElementById('bulkDeleteProgressLabel');
  const progressBar   = document.getElementById('bulkDeleteProgressBar');
  const progressCount = document.getElementById('bulkDeleteProgressCount');

  const endpoint = tab === 'media'  ? '/api/media/file'  :
                   tab === 'videos' ? '/api/videos/file' : '/api/files/file';
  const paramKey = tab === 'media'  ? 'imageUrl' :
                   tab === 'videos' ? 'videoUrl' : 'fileUrl';

  let done = 0, succeeded = 0;
  const failures = [];

  for (const item of items) {
    if (state.bulkDeleteAbortFlag) break;

    const name = item.filename || item.name || item.url.split('/').pop();
    progressLabel.textContent = `Deleting… ${done + 1} / ${n}`;
    progressBar.style.width   = `${Math.round((done / n) * 100)}%`;
    progressCount.textContent = `${done} / ${n}`;

    try {
      const params = new URLSearchParams({ [paramKey]: item.url });
      const res    = await api(`${endpoint}?${params}`, { method: 'DELETE' });
      const data   = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Delete failed');

      // Remove card from DOM immediately
      const card = document.querySelector(`[data-media-url="${CSS.escape(item.url)}"]`);
      if (card) card.remove();

      // Remove from in-memory state
      if (tab === 'media') {
        state.allImages      = state.allImages.filter(i => i.url !== item.url);
        state.filteredImages = state.filteredImages.filter(i => i.url !== item.url);
      } else if (tab === 'videos') {
        state.allVideos      = state.allVideos.filter(v => v.url !== item.url);
        state.filteredVideos = state.filteredVideos.filter(v => v.url !== item.url);
      } else {
        state.allFiles      = state.allFiles.filter(f => f.url !== item.url);
        state.filteredFiles = state.filteredFiles.filter(f => f.url !== item.url);
      }

      succeeded++;
    } catch (e) {
      if (e.message === 'Unauthorized') { state.bulkDeleteAbortFlag = true; break; }
      failures.push(`${name} — ${e.message}`);
    }

    done++;
    progressBar.style.width   = `${Math.round((done / n) * 100)}%`;
    progressCount.textContent = `${done} / ${n}`;
  }

  // Update count display and exit select mode
  if (tab === 'media') {
    document.getElementById('mediaCount').textContent =
      `${state.filteredImages.length} image${state.filteredImages.length !== 1 ? 's' : ''}`;
    clearSelection();
  } else if (tab === 'videos') {
    document.getElementById('videoCount').textContent =
      `${state.filteredVideos.length} video${state.filteredVideos.length !== 1 ? 's' : ''}`;
    clearVideoSelection();
  } else {
    document.getElementById('filesCount').textContent =
      `${state.filteredFiles.length} file${state.filteredFiles.length !== 1 ? 's' : ''}`;
    clearFilesSelection();
  }

  // Show summary
  const summaryEl = document.getElementById('bulkDeleteSummary');
  let html = '';
  if (succeeded > 0) html += `<div style="color:var(--success)">\u2705 ${succeeded} deleted successfully</div>`;
  if (failures.length > 0) html += failures.map(f => `<div style="color:var(--danger)">\u274c ${escapeHtml(f)}</div>`).join('');
  if (state.bulkDeleteAbortFlag && succeeded === 0 && failures.length === 0)
    html += `<div style="color:var(--warning)">\u26a0 Aborted — no items were deleted.</div>`;
  summaryEl.innerHTML = html;

  _showBulkDeletePhase('summary');
}

(function _wireBulkDeleteModal() {
  document.getElementById('bulkDeleteCancelBtn').addEventListener('click', closeBulkDeleteModal);
  document.getElementById('bulkDeleteCloseBtn').addEventListener('click', closeBulkDeleteModal);
  document.getElementById('bulkDeleteAbortBtn').addEventListener('click', () => {
    state.bulkDeleteAbortFlag = true;
    document.getElementById('bulkDeleteAbortBtn').disabled = true;
  });
  document.getElementById('bulkDeleteConfirmBtn').addEventListener('click', () => {
    document.getElementById('bulkDeleteConfirmBtn').disabled = true;
    _runBulkDelete();
  });
  document.getElementById('bulkDeleteOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('bulkDeleteOverlay')) closeBulkDeleteModal();
  });
})();

// ── Posts tab ────────────────────────────────────────────────────────────────
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

let _postsTabInitialised = false;

function initPostsTab() {
  if (!_postsTabInitialised) {
    _postsTabInitialised = true;
    // Wire toolbar controls
    document.getElementById('postsSearch').addEventListener('input', applyPostsFilter);
    document.getElementById('postsTypeFilter').addEventListener('change', applyPostsFilter);
    document.getElementById('postsStatusFilter').addEventListener('change', applyPostsFilter);
    document.getElementById('postsRefreshBtn').addEventListener('click', () => loadPosts(true));
    document.getElementById('bulkExcerptBtn').addEventListener('click', openBulkExcerptDialog);
    document.getElementById('createFromImagesBtn').addEventListener('click', openCreateAiPostDialog);
  }
  // Disable AI buttons immediately based on server config
  _updatePostsAiButtons();
  // Load if not already cached
  if (state.postsData.length === 0) {
    loadPosts();
  } else {
    applyPostsFilter();
  }
}

function _updatePostsAiButtons() {
  const ai = state.aiAvailable;
  const bulkBtn   = document.getElementById('bulkExcerptBtn');
  const createBtn = document.getElementById('createFromImagesBtn');
  bulkBtn.disabled   = !ai;
  createBtn.disabled = !ai;
  if (!ai) {
    bulkBtn.title   = 'Requires ANTHROPIC_API_KEY in server .env';
    createBtn.title = 'Requires ANTHROPIC_API_KEY in server .env';
  } else {
    bulkBtn.title   = 'Generate excerpts for posts missing one';
    createBtn.title = 'Create a new draft post from selected images';
  }
}

async function loadPosts(forceRefresh = false) {
  if (!forceRefresh && state.postsData.length > 0) { applyPostsFilter(); return; }
  _setPostsState('loading');
  try {
    const res  = await api('/api/posts');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load posts');
    state.postsData = [
      ...(data.posts || []).map(p => ({ ...p, _type: 'post' })),
      ...(data.pages || []).map(p => ({ ...p, _type: 'page' })),
    ];
    applyPostsFilter();
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      _setPostsState('empty');
      toast('Failed to load posts: ' + e.message, 'error');
    }
  }
}

function applyPostsFilter() {
  const query  = (document.getElementById('postsSearch').value || '').toLowerCase();
  const type   = document.getElementById('postsTypeFilter').value;   // all / post / page
  const status = document.getElementById('postsStatusFilter').value; // all / published / draft

  state.postsFiltered = state.postsData.filter(p => {
    if (type   !== 'all' && p._type   !== type)   return false;
    if (status !== 'all' && p.status  !== status) return false;
    if (query) {
      const inTitle   = (p.title  || '').toLowerCase().includes(query);
      const inExcerpt = (p.custom_excerpt || '').toLowerCase().includes(query);
      const inTags    = (p.tags  || []).some(t => t.name.toLowerCase().includes(query));
      if (!inTitle && !inExcerpt && !inTags) return false;
    }
    return true;
  });

  renderPostsTable();
}

function renderPostsTable() {
  const tbody = document.getElementById('postsTableBody');
  const posts = state.postsFiltered;

  document.getElementById('postsCount').textContent =
    `${posts.length} of ${state.postsData.length} post${state.postsData.length !== 1 ? 's' : ''}`;

  if (posts.length === 0) {
    _setPostsState(state.postsData.length === 0 ? 'loading' : 'empty');
    return;
  }
  _setPostsState('table');

  tbody.innerHTML = posts.map(p => {
    const customExcerpt  = p.custom_excerpt || '';
    const excerptHtml  = customExcerpt
      ? `<span class="post-excerpt">${_esc(customExcerpt.slice(0, 120))}${customExcerpt.length > 120 ? '…' : ''}</span>`
      : `<span class="post-excerpt missing">No excerpt set</span>`;

    const tagsHtml = (p.tags || []).length
      ? `<div class="post-tags">${(p.tags).map(t => `<span class="post-tag">${_esc(t.name)}</span>`).join('')}</div>`
      : `<span style="color:var(--text-dim);font-size:11px">—</span>`;

    const updated = p.updated_at
      ? new Date(p.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

    const statusCls = p.status === 'published' ? 'published' : p.status === 'scheduled' ? 'scheduled' : 'draft';
    const statusLbl = p.status === 'published' ? 'Published' : p.status === 'scheduled' ? 'Scheduled' : 'Draft';

    const aiDis = state.aiAvailable ? '' : ' disabled title="Requires ANTHROPIC_API_KEY"';

    return `<tr class="posts-tr" data-post-id="${_esc(p.id)}" data-post-type="${p._type === 'page' ? 'pages' : 'posts'}">
      <td class="posts-td">
        <a class="post-title-link" href="${_esc(p.url)}" target="_blank" rel="noopener">${_esc(p.title || '(untitled)')}</a>
      </td>
      <td class="posts-td" style="white-space:nowrap;color:var(--text-muted)">${p._type}</td>
      <td class="posts-td"><span class="post-status ${statusCls}">${statusLbl}</span></td>
      <td class="posts-td">${tagsHtml}</td>
      <td class="posts-td">${excerptHtml}</td>
      <td class="posts-td" style="white-space:nowrap;color:var(--text-muted);font-size:12px">${updated}</td>
      <td class="posts-td">
        <div class="post-actions">
          <button class="post-row-btn post-row-btn-excerpt" data-action="excerpt"${aiDis}>✨ Excerpt</button>
          <button class="post-row-btn post-row-btn-improve" data-action="improve"${aiDis}>🪄 Improve</button>
          <button class="post-row-btn post-row-btn-landscape" data-action="landscape"${p.feature_image ? '' : ' disabled title="No feature image set"'}>🖼️ Landscape</button>
          <button class="post-row-btn post-row-btn-open"    data-action="open">↗</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Bind row action buttons
  tbody.querySelectorAll('.post-row-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const tr     = e.target.closest('tr');
      const postId = tr.dataset.postId;
      const type   = tr.dataset.postType;  // 'posts' or 'pages'
      const action = btn.dataset.action;
      const post   = state.postsData.find(p => p.id === postId);
      if (!post) return;
      if      (action === 'excerpt')   openExcerptDialog(post, type);
      else if (action === 'improve')   openImproveDialog(post, type);
      else if (action === 'landscape') makeLandscape(post, btn);
      else if (action === 'open')      window.open(post.url, '_blank', 'noopener');
    });
  });
}

function _setPostsState(mode) {
  document.getElementById('postsState').style.display      = mode === 'loading' ? 'flex'  : 'none';
  document.getElementById('postsEmpty').style.display      = mode === 'empty'   ? 'flex'  : 'none';
  document.getElementById('postsTableWrap').style.display  = mode === 'table'   ? 'block' : 'none';
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Make Landscape ──────────────────────────────────────────────────────────
async function makeLandscape(post, btn) {
  const original = btn.textContent;
  btn.disabled    = true;
  btn.textContent = '⏳…';

  try {
    const res  = await api(`/api/posts/${post.id}/make-landscape`, { method: 'POST' });
    const data = await res.json();

    if (res.status === 400 && data.error === 'Image is already landscape') {
      toast('Image is already landscape — nothing to do.', 'info');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Failed');

    post.feature_image = data.url;
    toast('Feature image converted to landscape ✓', 'success');
  } catch (e) {
    toast(`Landscape conversion failed: ${e.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = original;
  }
}

// Stubs — replaced in later steps
// ── Excerpt dialog ─────────────────────────────────────────────────────────────

let _excerptPost = null;
let _excerptType = null;

function openExcerptDialog(post, type) {
  _excerptPost = post;
  _excerptType = type;

  document.getElementById('excerptPostTitle').textContent = post.title || '(untitled)';

  const current = post.custom_excerpt || '';
  const curWrap = document.getElementById('excerptCurrentWrap');
  if (current) {
    document.getElementById('excerptCurrent').textContent = current;
    curWrap.style.display = 'block';
  } else {
    curWrap.style.display = 'none';
  }

  document.getElementById('excerptGenerating').style.display  = 'none';
  document.getElementById('excerptResultWrap').style.display  = 'none';
  document.getElementById('excerptRegenerateBtn').style.display = 'none';
  const _eBtn = document.getElementById('excerptSaveBtn');
  _eBtn.style.display  = 'none';
  _eBtn.disabled       = false;
  _eBtn.textContent    = '✔ Save Excerpt';
  document.getElementById('excerptResult').value = '';
  document.getElementById('excerptCharCount').textContent = '';

  document.getElementById('excerptOverlay').classList.add('show');
  _generateExcerpt();
}

function closeExcerptDialog() {
  document.getElementById('excerptOverlay').classList.remove('show');
  _excerptPost = null;
  _excerptType = null;
}

async function _generateExcerpt() {
  document.getElementById('excerptGenerating').style.display  = 'flex';
  document.getElementById('excerptResultWrap').style.display  = 'none';
  document.getElementById('excerptRegenerateBtn').style.display = 'none';
  document.getElementById('excerptSaveBtn').style.display       = 'none';

  try {
    const res  = await api('/api/ai/excerpt', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        postId:   _excerptPost.id,
        postType: _excerptType,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI request failed');

    document.getElementById('excerptResult').value = data.excerpt;
    _updateExcerptCharCount();
    document.getElementById('excerptGenerating').style.display   = 'none';
    document.getElementById('excerptResultWrap').style.display   = 'block';
    document.getElementById('excerptRegenerateBtn').style.display = 'inline-flex';
    document.getElementById('excerptSaveBtn').style.display       = 'inline-flex';
  } catch (e) {
    document.getElementById('excerptGenerating').style.display = 'none';
    if (e.message !== 'Unauthorized') toast('Excerpt generation failed: ' + e.message, 'error');
    closeExcerptDialog();
  }
}

function _updateExcerptCharCount() {
  const val = document.getElementById('excerptResult').value;
  const el  = document.getElementById('excerptCharCount');
  el.textContent = `${val.length} / 300 characters`;
  el.style.color = val.length > 300 ? 'var(--danger)' : 'var(--text-muted)';
}

async function _saveExcerpt() {
  const excerpt = document.getElementById('excerptResult').value.trim();
  if (!excerpt) return;

  const saveBtn = document.getElementById('excerptSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const res = await api(
      `/api/posts/${_excerptType}/${_excerptPost.id}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          [_excerptType]: [{ id: _excerptPost.id, custom_excerpt: excerpt, updated_at: _excerptPost.updated_at }],
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.errors?.[0]?.message || data.error || 'Save failed');

    // Update local state so table reflects new excerpt without a full reload
    const idx = state.postsData.findIndex(p => p.id === _excerptPost.id);
    if (idx >= 0) {
      state.postsData[idx].custom_excerpt = excerpt;
      state.postsData[idx].updated_at = data[_excerptType]?.[0]?.updated_at || _excerptPost.updated_at;
    }
    toast('✔ Excerpt saved!', 'success');
    closeExcerptDialog();
    applyPostsFilter();
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Save failed: ' + e.message, 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = '✔ Save Excerpt';
  }
}

// Wire up excerpt dialog listeners (called once from initPostsTab EXTENSION)
(function _wireExcerptDialog() {
  document.getElementById('excerptCancelBtn').addEventListener('click', closeExcerptDialog);
  document.getElementById('excerptRegenerateBtn').addEventListener('click', _generateExcerpt);
  document.getElementById('excerptSaveBtn').addEventListener('click', _saveExcerpt);
  document.getElementById('excerptResult').addEventListener('input', _updateExcerptCharCount);
  document.getElementById('excerptOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('excerptOverlay')) closeExcerptDialog();
  });
})();
// ── Improve dialog ───────────────────────────────────────────────────────────

// ── Shared language list (used by both Create AI Draft Post and Improve dialogs) ──
const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
];

function buildLanguageSelect(el) {
  el.innerHTML = LANGUAGES.map(l => `<option value="${l.value}">${l.label}</option>`).join('');
}
// Populate both language selects on page load
buildLanguageSelect(document.getElementById('cfigLanguage'));
buildLanguageSelect(document.getElementById('improveLanguage'));

let _improvePost = null;
let _improveType = null;
let _improveSuggestions   = null;
let _improveCurrentValues = null;

// Field config: id, label, Ghost API key (null = read-only, not saved directly)
const IMPROVE_FIELDS = [
  { id: 'title',            label: 'Title',           key: 'title' },
  { id: 'excerpt',          label: 'Excerpt',         key: 'custom_excerpt' },
  { id: 'meta_title',       label: 'SEO Title',       key: 'meta_title' },
  { id: 'meta_description', label: 'SEO Description', key: 'meta_description' },
  { id: 'tags',             label: 'Tags',            key: 'tags' },
  { id: 'body',             label: 'Post Body',       key: null },
];

function _updateImproveStartBtn() {
  const any = Array.from(document.querySelectorAll('.improve-field-chk')).some(c => c.checked);
  document.getElementById('improveStartBtn').disabled = !any;
}

function openImproveDialog(post, type) {
  if (!state.aiAvailable) { toast('AI not available – set ANTHROPIC_API_KEY on the server.', 'error'); return; }
  _improvePost = post;
  _improveType = type;
  _improveSuggestions   = null;
  _improveCurrentValues = null;

  document.getElementById('improvePostTitle').textContent = post.title || '(untitled)';

  // Show setup screen, hide all others
  document.getElementById('improveSetupScreen').style.display      = 'block';
  document.getElementById('improveGenerating').style.display        = 'none';
  document.getElementById('improveResults').style.display           = 'none';
  document.getElementById('improveStartBtn').style.display          = 'inline-flex';
  document.getElementById('improveBackBtn').style.display           = 'none';
  document.getElementById('improveRegenerateBtn').style.display     = 'none';
  document.getElementById('improveSaveBtn').style.display           = 'none';
  document.getElementById('improveCancelBtn').textContent           = 'Cancel';

  // Reset setup fields
  document.querySelectorAll('.improve-field-chk').forEach(c => { c.checked = true; });
  document.getElementById('improveInstructions').value              = '';
  document.getElementById('improveInstructionsCounter').textContent = '0 / 500';
  document.getElementById('improveInstructionsCounter').style.color = 'var(--text-dim)';
  document.getElementById('improveLanguage').value                  = state.ghostLang || 'en';
  document.getElementById('improveStartBtn').disabled               = false;

  // Reset body mode to feedback, restore visibility
  document.getElementById('improveBodyModeFeedback').checked       = true;
  document.getElementById('improveBodyModeRow').style.display      = 'flex';
  document.getElementById('improveBodyLengthRow').style.display    = 'none';

  document.getElementById('improveSaveBtn').disabled    = false;
  document.getElementById('improveSaveBtn').textContent  = '\u2714 Apply Selected';

  document.getElementById('improveOverlay').classList.add('show');
}

function closeImproveDialog() {
  document.getElementById('improveOverlay').classList.remove('show');
  _improvePost = null;
  _improveType = null;
}

async function _runImprove() {
  const fields = Array.from(document.querySelectorAll('.improve-field-chk:checked')).map(c => c.value);
  if (fields.length === 0) { toast('Select at least one field.', 'info'); return; }

  const instructions  = document.getElementById('improveInstructions').value.trim().slice(0, 500);
  const language      = document.getElementById('improveLanguage').value;
  const bodyModeEl    = document.querySelector('input[name="improveBodyMode"]:checked');
  const bodyMode      = bodyModeEl ? bodyModeEl.value : 'feedback';
  const bodyLengthEl  = document.querySelector('input[name="improveBodyLength"]:checked');
  const bodyLength    = bodyLengthEl ? bodyLengthEl.value : 'medium';

  // Transition to loading state
  document.getElementById('improveSetupScreen').style.display      = 'none';
  document.getElementById('improveStartBtn').style.display          = 'none';
  document.getElementById('improveBackBtn').style.display           = 'none';
  document.getElementById('improveRegenerateBtn').style.display     = 'none';
  document.getElementById('improveSaveBtn').style.display           = 'none';
  document.getElementById('improveGenerating').style.display        = 'flex';
  document.getElementById('improveResults').style.display           = 'none';
  document.getElementById('improveCancelBtn').textContent           = 'Close';

  try {
    const res  = await api('/api/ai/improve', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ postId: _improvePost.id, postType: _improveType, fields, instructions, language, bodyMode, bodyLength }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI request failed');

    // Warn before showing generated content if post already has text
    if (data.warnExistingContent && bodyMode === 'generate') {
      const proceed = window.confirm(
        `⚠ This post already has text content (~${data.wordCount} words).\n\n` +
        `Generated paragraphs will be added alongside existing content, not replace it.\n` +
        `Consider "Feedback only" mode instead.\n\nContinue anyway?`
      );
      if (!proceed) {
        document.getElementById('improveGenerating').style.display  = 'none';
        document.getElementById('improveSetupScreen').style.display = 'block';
        document.getElementById('improveStartBtn').style.display    = 'inline-flex';
        document.getElementById('improveCancelBtn').textContent     = 'Cancel';
        return;
      }
    }

    _improveSuggestions   = data.suggestions;
    _improveCurrentValues = data.post;

    document.getElementById('improveGenerating').style.display    = 'none';
    document.getElementById('improveResults').style.display       = 'block';
    document.getElementById('improveRegenerateBtn').style.display = 'inline-flex';
    document.getElementById('improveBackBtn').style.display       = 'inline-flex';

    // Render general feedback (always present)
    const feedbackEl   = document.getElementById('improveFeedback');
    const feedbackText = (_improveSuggestions.feedback || '').trim();
    if (feedbackText) {
      feedbackEl.textContent   = feedbackText;
      feedbackEl.style.display = 'block';
    } else {
      feedbackEl.style.display = 'none';
    }

    // Render each requested field
    const container = document.getElementById('improveFields');
    container.innerHTML = '';
    let hasSaveable = false;

    for (const fld of IMPROVE_FIELDS) {
      if (!fields.includes(fld.id)) continue;

      if (fld.id === 'tags') {
        _renderTagsField(container);
        if (document.getElementById('improve-check-tags')) hasSaveable = true;
      } else if (fld.id === 'body') {
        if (bodyMode === 'generate' && data.generated) {
          _renderBodyGenerated(container, data.generated);
          hasSaveable = true;
        } else {
          _renderBodyFeedback(container);
        }
      } else {
        const suggested = (_improveSuggestions[fld.id] || '').trim();
        const currentKey = fld.id === 'excerpt' ? 'excerpt' : fld.id;
        const current    = (_improveCurrentValues[currentKey] || '').trim();
        const isNew      = suggested && suggested !== current;

        const div = document.createElement('div');
        div.className = 'improve-field';
        let inner = `
          <div class="improve-field-header">
            <span class="improve-field-label">${_esc(fld.label)}</span>
            <span class="${isNew ? 'improve-badge-new' : 'improve-badge-same'}">${isNew ? 'Improved' : '✓ No change suggested'}</span>
          </div>`;
        if (current) inner += `<div class="improve-current">${_esc(current)}</div>`;
        if (isNew) {
          inner += `<div class="improve-new">${_esc(suggested)}</div>
          <div class="improve-apply-row">
            <input type="checkbox" id="improve-check-${fld.id}" checked>
            <label for="improve-check-${fld.id}">Apply this suggestion</label>
          </div>`;
          hasSaveable = true;
        } else if (!current) {
          inner += `<div style="font-size:12px;color:var(--text-dim);font-style:italic">(none set)</div>`;
        }
        div.innerHTML = inner;
        container.appendChild(div);
      }
    }

    if (hasSaveable) {
      document.getElementById('improveSaveBtn').style.display = 'inline-flex';
    }
  } catch (e) {
    document.getElementById('improveGenerating').style.display = 'none';
    if (e.message !== 'Unauthorized') toast('Improve failed: ' + e.message, 'error');
    closeImproveDialog();
  }
}

function _renderTagsField(container) {
  const toAdd    = Array.isArray(_improveSuggestions.tags_to_add)    ? _improveSuggestions.tags_to_add    : [];
  const toRemove = Array.isArray(_improveSuggestions.tags_to_remove) ? _improveSuggestions.tags_to_remove : [];
  const current  = _improveCurrentValues.tags || [];
  const hasChanges = toAdd.length > 0 || toRemove.length > 0;

  const div = document.createElement('div');
  div.className = 'improve-field';

  const currentChips = current.map(t => `<span class="post-tag">${_esc(t.name)}</span>`).join('');
  const addChips     = toAdd.map(n => `<span class="improve-tag-add">+ ${_esc(n)}</span>`).join('');
  const removeChips  = toRemove.map(n => `<span class="improve-tag-remove">&minus; ${_esc(n)}</span>`).join('');

  let inner = `
    <div class="improve-field-header">
      <span class="improve-field-label">Tags</span>
      <span class="${hasChanges ? 'improve-badge-new' : 'improve-badge-same'}">${hasChanges ? 'Improved' : '✓ No change suggested'}</span>
    </div>`;
  if (current.length)  inner += `<div style="margin-bottom:6px;display:flex;align-items:baseline;gap:6px"><span style="font-size:11px;color:var(--text-dim);white-space:nowrap">Current:</span><span class="post-tags">${currentChips}</span></div>`;
  if (toAdd.length)    inner += `<div style="margin-bottom:4px;display:flex;align-items:baseline;gap:6px"><span style="font-size:11px;color:var(--text-dim);white-space:nowrap">+ Add:</span><span class="improve-tag-chips">${addChips}</span></div>`;
  if (toRemove.length) inner += `<div style="margin-bottom:4px;display:flex;align-items:baseline;gap:6px"><span style="font-size:11px;color:var(--text-dim);white-space:nowrap">&minus; Remove:</span><span class="improve-tag-chips">${removeChips}</span></div>`;
  if (hasChanges) {
    inner += `<div class="improve-apply-row">
      <input type="checkbox" id="improve-check-tags" checked>
      <label for="improve-check-tags">Apply these tag changes</label>
    </div>`;
  }
  div.innerHTML = inner;
  container.appendChild(div);
}

function _renderBodyGenerated(container, generated) {
  const { intro, body, outro } = generated || {};
  if (!intro && !body && !outro) return;

  const div = document.createElement('div');
  div.className = 'improve-field';

  let inner = `<div class="improve-field-header"><span class="improve-field-label">Generated Content</span></div>`;

  const sections = [
    { id: 'Intro', label: 'INTRO', text: intro },
    { id: 'Body',  label: 'BODY',  text: body  },
    { id: 'Outro', label: 'OUTRO', text: outro },
  ];
  for (const s of sections) {
    if (!s.text) continue;
    inner += `
      <div style="margin-bottom:10px;border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em">${_esc(s.label)}</span>
          <button class="btn btn-ghost improve-gen-edit" style="font-size:11px;padding:2px 8px" data-target="improveBody${_esc(s.id)}">Edit &#x25BC;</button>
        </div>
        <div class="improve-current" style="white-space:pre-wrap;max-height:100px;overflow-y:auto">${_esc(s.text)}</div>
        <textarea id="improveBody${_esc(s.id)}" class="text-input" rows="4" style="display:none;resize:vertical;width:100%;margin-top:6px;font-size:12px">${_esc(s.text)}</textarea>
      </div>`;
  }

  inner += `
    <div class="improve-apply-row">
      <input type="checkbox" id="improve-check-body-apply" checked>
      <label for="improve-check-body-apply">Apply generated content to post</label>
    </div>`;

  div.innerHTML = inner;
  container.appendChild(div);
}

function _renderBodyFeedback(container) {
  const feedback = (_improveSuggestions.body_feedback || '').trim();

  const div = document.createElement('div');
  div.className = 'improve-field';

  if (!feedback) {
    div.innerHTML = `
      <div class="improve-field-header">
        <span class="improve-field-label">Post Body Feedback</span>
        <span class="improve-badge-same">✓ No specific feedback</span>
      </div>`;
    container.appendChild(div);
    return;
  }

  const isLong    = feedback.length > 320;
  const shortText = isLong ? feedback.slice(0, 320) + '\u2026' : feedback;

  div.innerHTML = `
    <div class="improve-field-header">
      <span class="improve-field-label">Post Body Feedback</span>
    </div>
    <div class="improve-body-feedback">
      <span class="improve-body-text">${_esc(isLong ? shortText : feedback)}</span>${isLong
        ? ` <a class="improve-show-more" role="button" tabindex="0"
             data-full="${_esc(feedback)}" data-short="${_esc(shortText)}" data-expanded="false"
             style="cursor:pointer;color:var(--accent);font-size:12px;white-space:nowrap">Show&nbsp;more</a>`
        : ''}
    </div>`;
  container.appendChild(div);
}

async function _applyBodyContent() {
  const intro = document.getElementById('improveBodyIntro')?.value.trim() || null;
  const body  = document.getElementById('improveBodyBody')?.value.trim()  || null;
  const outro = document.getElementById('improveBodyOutro')?.value.trim() || null;

  const res = await api('/api/ai/apply-body', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      postId:     _improvePost.id,
      postType:   _improveType,
      updated_at: _improvePost.updated_at,
      intro, body, outro,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Apply body failed');
  _improvePost.updated_at = data.updated_at;
  const idx = state.postsData.findIndex(p => p.id === _improvePost.id);
  if (idx >= 0) state.postsData[idx].updated_at = data.updated_at;
}

async function _applyImprovements() {
  const saveBtn = document.getElementById('improveSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving\u2026';

  const payload = {};
  for (const fld of IMPROVE_FIELDS) {
    if (fld.key === null) continue; // body — read-only feedback, not saved
    if (fld.id === 'tags') {
      const chk = document.getElementById('improve-check-tags');
      if (chk && chk.checked) {
        const toAdd    = Array.isArray(_improveSuggestions.tags_to_add)    ? _improveSuggestions.tags_to_add    : [];
        const toRemove = Array.isArray(_improveSuggestions.tags_to_remove) ? _improveSuggestions.tags_to_remove : [];
        const current  = _improveCurrentValues.tags || [];
        const lowerRemove = toRemove.map(t => t.toLowerCase());
        const kept        = current.filter(t => !lowerRemove.includes(t.name.toLowerCase()));
        const lowerKept   = kept.map(t => t.name.toLowerCase());
        const additions   = toAdd
          .filter(name => !lowerKept.includes(name.toLowerCase()))
          .map(name => ({ name }));
        payload.tags = [...kept, ...additions];
      }
    } else {
      const chk = document.getElementById(`improve-check-${fld.id}`);
      if (chk && chk.checked) {
        const val = (_improveSuggestions[fld.id] || '').trim();
        if (val) payload[fld.key] = val;
      }
    }
  }

  const bodyApplyChecked = !!document.getElementById('improve-check-body-apply')?.checked;
  const hasFieldChanges   = Object.keys(payload).length > 0;

  if (!hasFieldChanges && !bodyApplyChecked) {
    toast('No fields selected.', 'info');
    saveBtn.disabled = false;
    saveBtn.textContent = '\u2714 Apply Selected';
    return;
  }

  try {
    if (hasFieldChanges) {
      payload.id         = _improvePost.id;
      payload.updated_at = _improvePost.updated_at;

      const res = await api(
        `/api/posts/${_improveType}/${_improvePost.id}`,
        {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ [_improveType]: [payload] }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.errors?.[0]?.message || data.error || 'Save failed');

      const idx = state.postsData.findIndex(p => p.id === _improvePost.id);
      if (idx >= 0) {
        const saved = data[_improveType]?.[0] || {};
        if (payload.title)            state.postsData[idx].title            = payload.title;
        if (payload.custom_excerpt)   state.postsData[idx].custom_excerpt   = payload.custom_excerpt;
        if (payload.meta_title)       state.postsData[idx].meta_title       = payload.meta_title;
        if (payload.meta_description) state.postsData[idx].meta_description = payload.meta_description;
        if (payload.tags)             state.postsData[idx].tags             = saved.tags || payload.tags;
        state.postsData[idx].updated_at = saved.updated_at || _improvePost.updated_at;
        _improvePost.updated_at = state.postsData[idx].updated_at;
      }
    }

    if (bodyApplyChecked) {
      await _applyBodyContent();
    }

    const fieldCount = Object.keys(payload).filter(k => k !== 'id' && k !== 'updated_at').length;
    const totalCount = fieldCount + (bodyApplyChecked ? 1 : 0);
    toast(`\u2714 ${totalCount} item${totalCount !== 1 ? 's' : ''} updated!`, 'success');
    closeImproveDialog();
    applyPostsFilter();
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Save failed: ' + e.message, 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = '\u2714 Apply Selected';
  }
}

(function _wireImproveDialog() {
  document.getElementById('improveCancelBtn').addEventListener('click', closeImproveDialog);
  document.getElementById('improveStartBtn').addEventListener('click', _runImprove);
  document.getElementById('improveRegenerateBtn').addEventListener('click', _runImprove);
  document.getElementById('improveSaveBtn').addEventListener('click', _applyImprovements);
  document.getElementById('improveBackBtn').addEventListener('click', () => {
    document.getElementById('improveResults').style.display       = 'none';
    document.getElementById('improveGenerating').style.display    = 'none';
    document.getElementById('improveRegenerateBtn').style.display = 'none';
    document.getElementById('improveSaveBtn').style.display       = 'none';
    document.getElementById('improveBackBtn').style.display       = 'none';
    document.getElementById('improveSetupScreen').style.display   = 'block';
    document.getElementById('improveStartBtn').style.display      = 'inline-flex';
    document.getElementById('improveCancelBtn').textContent       = 'Cancel';
  });
  document.getElementById('improveInstructions').addEventListener('input', () => {
    const len     = document.getElementById('improveInstructions').value.length;
    const counter = document.getElementById('improveInstructionsCounter');
    counter.textContent = `${len} / 500`;
    counter.style.color = len >= 480 ? 'var(--error)' : len >= 400 ? '#e6a817' : 'var(--text-dim)';
  });
  document.querySelectorAll('.improve-field-chk').forEach(chk => {
    chk.addEventListener('change', _updateImproveStartBtn);
  });
  // Body mode/length radio wiring
  document.getElementById('improve-check-body').addEventListener('change', e => {
    const modeRow = document.getElementById('improveBodyModeRow');
    modeRow.style.display = e.target.checked ? 'flex' : 'none';
    if (!e.target.checked) {
      document.getElementById('improveBodyModeFeedback').checked = true;
      document.getElementById('improveBodyLengthRow').style.display = 'none';
    }
  });
  document.querySelectorAll('input[name="improveBodyMode"]').forEach(r => {
    r.addEventListener('change', () => {
      const isGen = document.getElementById('improveBodyModeGenerate').checked;
      document.getElementById('improveBodyLengthRow').style.display = isGen ? 'flex' : 'none';
    });
  });
  document.getElementById('improveResults').addEventListener('click', e => {
    // Show more / show less toggle for body feedback
    const showMoreBtn = e.target.closest('.improve-show-more');
    if (showMoreBtn) {
      const textEl   = showMoreBtn.closest('.improve-body-feedback').querySelector('.improve-body-text');
      const expanded = showMoreBtn.dataset.expanded === 'true';
      textEl.textContent      = expanded ? showMoreBtn.dataset.short : showMoreBtn.dataset.full;
      showMoreBtn.textContent = expanded ? 'Show\u00a0more' : 'Show\u00a0less';
      showMoreBtn.dataset.expanded = String(!expanded);
    }
    // Edit ▼ toggle for generated content sections
    const editBtn = e.target.closest('.improve-gen-edit');
    if (editBtn) {
      const targetId = editBtn.dataset.target;
      const ta = document.getElementById(targetId);
      if (!ta) return;
      const expanded = ta.style.display === 'block';
      ta.style.display    = expanded ? 'none' : 'block';
      editBtn.innerHTML   = expanded ? 'Edit &#x25BC;' : 'Close &#x25B2;';
    }
  });
  document.getElementById('improveOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('improveOverlay')) closeImproveDialog();
  });
})();
// ── Bulk excerpt dialog ─────────────────────────────────────────────────────────

let _bulkAborted = false;

function openBulkExcerptDialog() {
  _bulkAborted = false;

  // Reset to config screen
  document.getElementById('bulkExcerptConfig').style.display   = 'block';
  document.getElementById('bulkExcerptProgress').style.display = 'none';
  document.getElementById('bulkIncludeExisting').checked       = false;
  document.getElementById('bulkProgressLog').innerHTML         = '';
  document.getElementById('bulkProgressBar').style.width       = '0%';
  document.getElementById('bulkExcerptDoneBtn').style.display  = 'none';
  document.getElementById('bulkExcerptAbortBtn').style.display = 'inline-flex';

  _updateBulkScope();
  document.getElementById('bulkExcerptOverlay').classList.add('show');
}

function closeBulkExcerptDialog() {
  _bulkAborted = true;
  document.getElementById('bulkExcerptOverlay').classList.remove('show');
}

function _updateBulkScope() {
  const includeExisting = document.getElementById('bulkIncludeExisting').checked;
  const eligible = state.postsData.filter(p =>
    includeExisting ? true : !p.custom_excerpt
  );
  document.getElementById('bulkScope').textContent =
    `${eligible.length} post${eligible.length !== 1 ? 's' : ''} will be processed ` +
    `(${state.postsData.length} total)`;
}

async function _runBulkExcerpts() {
  _bulkAborted = false;
  const includeExisting = document.getElementById('bulkIncludeExisting').checked;
  const queue = state.postsData.filter(p =>
    includeExisting ? true : !p.custom_excerpt
  );

  if (queue.length === 0) {
    toast('No posts to process.', 'info');
    closeBulkExcerptDialog();
    return;
  }

  document.getElementById('bulkExcerptConfig').style.display   = 'none';
  document.getElementById('bulkExcerptProgress').style.display = 'block';

  const log     = document.getElementById('bulkProgressLog');
  const bar     = document.getElementById('bulkProgressBar');
  const label   = document.getElementById('bulkProgressLabel');
  const counter = document.getElementById('bulkProgressCount');

  let done = 0, succeeded = 0, failed = 0;

  function addLog(text, color) {
    const el = document.createElement('div');
    el.style.color = color || 'var(--text-muted)';
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  for (const post of queue) {
    if (_bulkAborted) break;

    const postType = post._type === 'page' ? 'pages' : 'posts';
    label.textContent   = `Processing: ${post.title || '(untitled)'}`;
    counter.textContent = `${done} / ${queue.length}`;
    bar.style.width     = `${Math.round((done / queue.length) * 100)}%`;

    try {
      const res  = await api('/api/ai/excerpt', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ postId: post.id, postType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI failed');

      // Save to Ghost
      const saveRes = await api(
        `/api/posts/${postType}/${post.id}`,
        {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            [postType]: [{ id: post.id, custom_excerpt: data.excerpt, updated_at: post.updated_at }],
          }),
        }
      );
      const saveData = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveData.errors?.[0]?.message || 'Save failed');

      // Reflect in state
      const idx = state.postsData.findIndex(p => p.id === post.id);
      if (idx >= 0) {
        state.postsData[idx].custom_excerpt = data.excerpt;
        state.postsData[idx].updated_at = saveData[postType]?.[0]?.updated_at || post.updated_at;
      }

      succeeded++;
      addLog(`✔ ${post.title || post.id}`, 'var(--success)');
    } catch (e) {
      if (e.message === 'Unauthorized') { _bulkAborted = true; break; }
      failed++;
      addLog(`✖ ${post.title || post.id}: ${e.message}`, 'var(--danger)');
    }

    done++;
  }

  bar.style.width     = '100%';
  counter.textContent = `${done} / ${queue.length}`;
  label.textContent   = _bulkAborted
    ? `Stopped — ${succeeded} saved, ${failed} failed`
    : `Done — ${succeeded} saved, ${failed} failed`;

  document.getElementById('bulkExcerptAbortBtn').style.display = 'none';
  document.getElementById('bulkExcerptDoneBtn').style.display  = 'inline-flex';

  if (succeeded > 0) applyPostsFilter();
}

(function _wireBulkExcerptDialog() {
  document.getElementById('bulkExcerptCancelBtn').addEventListener('click', closeBulkExcerptDialog);
  document.getElementById('bulkExcerptAbortBtn').addEventListener('click', () => { _bulkAborted = true; });
  document.getElementById('bulkExcerptDoneBtn').addEventListener('click', closeBulkExcerptDialog);
  document.getElementById('bulkExcerptStartBtn').addEventListener('click', _runBulkExcerpts);
  document.getElementById('bulkIncludeExisting').addEventListener('change', _updateBulkScope);
  document.getElementById('bulkExcerptOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('bulkExcerptOverlay')) closeBulkExcerptDialog();
  });
})();
// ── Create AI Draft Post dialog ─────────────────────────────────────────────
// Dialog opens from: navbar createAiPostBtn, Posts tab createFromImagesBtn.
// Uses state.selectedImages, state.selectedVideos, state.selectedFiles (PDFs only).

function openCreateAiPostDialog() {
  if (!state.aiAvailable) { toast('AI not available – set ANTHROPIC_API_KEY on the server.', 'error'); return; }

  const pdfFiles    = state.selectedFiles.filter(f => f.url?.toLowerCase().endsWith('.pdf'));
  const nonPdfFiles = state.selectedFiles.filter(f => !f.url?.toLowerCase().endsWith('.pdf'));
  const overlay     = document.getElementById('createFromImagesOverlay');

  // ── Build media strip ──
  const strip = document.getElementById('cfigImageStrip');
  strip.innerHTML = '';

  state.selectedImages.forEach(img => {
    const el = document.createElement('img');
    el.className = 'cfig-preview-thumb';
    el.src = img.url;
    el.alt = img.fileName || '';
    strip.appendChild(el);
  });

  state.selectedVideos.forEach(vid => {
    const el = document.createElement('div');
    el.className = 'cfig-preview-thumb';
    el.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;font-size:22px;background:var(--surface3);border-radius:var(--radius)';
    el.title = vid.fileName || vid.url;
    el.textContent = '🎬';
    strip.appendChild(el);
  });

  pdfFiles.forEach(f => {
    const el = document.createElement('div');
    el.className = 'cfig-preview-thumb';
    el.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;font-size:22px;background:var(--surface3);border-radius:var(--radius)';
    el.title = f.fileName || f.url;
    el.textContent = '📄';
    strip.appendChild(el);
  });

  // ── Non-PDF notice ──
  const noticeEl = document.getElementById('cfigNonPdfNotice');
  if (nonPdfFiles.length > 0) {
    const exts = [...new Set(nonPdfFiles.map(f => (f.url || '').split('.').pop().toUpperCase()))]
      .filter(Boolean).join(', ');
    noticeEl.textContent = `ℹ️ ${nonPdfFiles.length} non-PDF file${nonPdfFiles.length !== 1 ? 's' : ''} excluded (${exts})`;
    noticeEl.style.display = 'block';
  } else {
    noticeEl.style.display = 'none';
  }

  // ── No-media hint ──
  const totalMedia = state.selectedImages.length + state.selectedVideos.length + pdfFiles.length;
  document.getElementById('cfigNoMediaHint').style.display = totalMedia === 0 ? 'block' : 'none';

  // ── Reset all screens ──
  ['cfigSetupScreen','cfigGenerating','cfigFields','cfigError','cfigSaved']
    .forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById('cfigCloseBtn').textContent          = 'Cancel';
  document.getElementById('cfigGenerateBtn').style.display     = 'none';
  document.getElementById('cfigRegenerateBtn').style.display   = 'none';
  document.getElementById('cfigSaveBtn').style.display         = 'none';

  // ── Reset prompt + language ──
  document.getElementById('cfigPrompt').value = '';
  _cfigUpdateCounter();
  document.getElementById('cfigLanguage').value = 'en';

  // ── Show setup screen ──
  document.getElementById('cfigSetupScreen').style.display = 'block';
  document.getElementById('cfigGenerateBtn').style.display = 'inline-flex';
  overlay.classList.add('show');
}

function _cfigUpdateCounter() {
  const len     = document.getElementById('cfigPrompt').value.length;
  const counter = document.getElementById('cfigPromptCounter');
  const genBtn  = document.getElementById('cfigGenerateBtn');
  if (len >= 20) {
    counter.textContent = `${len} / 20 ✓`;
    counter.style.color = '#4caf50';
    if (genBtn) genBtn.disabled = false;
  } else {
    counter.textContent = `${len} / 20 min`;
    counter.style.color = 'var(--error)';
    if (genBtn) genBtn.disabled = true;
  }
}

function _cfigStartAnalysis() {
  ['cfigSetupScreen','cfigFields','cfigError','cfigSaved'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('cfigGenerateBtn').style.display   = 'none';
  document.getElementById('cfigRegenerateBtn').style.display = 'none';
  document.getElementById('cfigSaveBtn').style.display       = 'none';
  document.getElementById('cfigGenerating').style.display    = 'flex';
  _runCreateFromImages();
}

async function _runCreateFromImages() {
  try {
    const pdfUrls = state.selectedFiles
      .filter(f => f.url?.toLowerCase().endsWith('.pdf'))
      .map(f => f.url);

    const r = await api('/api/ai/create-from-images', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt:    document.getElementById('cfigPrompt').value.trim(),
        imageUrls: state.selectedImages.map(i => i.url),
        videoUrls: state.selectedVideos.map(v => v.url),
        pdfUrls,
        language:  document.getElementById('cfigLanguage').value,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'AI request failed');

    const { draft } = data;
    document.getElementById('cfigTitle').value   = draft.title   || '';
    document.getElementById('cfigExcerpt').value = draft.excerpt || '';
    document.getElementById('cfigContent').value = draft.html    || '';
    document.getElementById('cfigTags').value    = Array.isArray(draft.tags) ? draft.tags.join(', ') : '';

    // Feature image: images only
    const sel = document.getElementById('cfigFeatureImage');
    sel.innerHTML = '<option value="">— none —</option>';
    state.selectedImages.forEach(img => {
      const opt = document.createElement('option');
      opt.value       = img.url;
      opt.textContent = (img.fileName || img.url.split('/').pop()).slice(0, 50);
      sel.appendChild(opt);
    });
    if (state.selectedImages.length > 0) sel.value = state.selectedImages[0].url;

    document.getElementById('cfigGenerating').style.display    = 'none';
    document.getElementById('cfigFields').style.display        = 'block';
    document.getElementById('cfigRegenerateBtn').style.display = 'inline-flex';
    document.getElementById('cfigSaveBtn').style.display       = 'inline-flex';
  } catch (e) {
    document.getElementById('cfigGenerating').style.display    = 'none';
    document.getElementById('cfigError').style.display         = 'block';
    document.getElementById('cfigError').textContent           = `Error: ${e.message}`;
    document.getElementById('cfigRegenerateBtn').style.display = 'inline-flex';
    document.getElementById('cfigCloseBtn').textContent        = 'Close';
  }
}

async function _saveCreateFromImages() {
  const saveBtn = document.getElementById('cfigSaveBtn');
  const title   = document.getElementById('cfigTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const tagsRaw         = document.getElementById('cfigTags').value;
  const tags            = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
  const featureImageUrl = document.getElementById('cfigFeatureImage').value || undefined;

  try {
    const r = await api('/api/posts/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        title,
        excerpt:         document.getElementById('cfigExcerpt').value.trim(),
        html:            document.getElementById('cfigContent').value.trim(),
        featureImageUrl,
        tags,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Create failed');

    document.getElementById('cfigFields').style.display        = 'none';
    document.getElementById('cfigRegenerateBtn').style.display = 'none';
    document.getElementById('cfigSaveBtn').style.display       = 'none';
    document.getElementById('cfigSaved').style.display         = 'block';
    document.getElementById('cfigCloseBtn').textContent        = 'Close';
    const link     = document.getElementById('cfigPostLink');
    link.href        = `${state.ghostUrl}/ghost/#/editor/post/${data.post.id}`;
    link.textContent = `Open "${data.post.title}" in Ghost Editor →`;
    toast(`Draft "${data.post.title}" created!`, 'success');
  } catch (e) {
    saveBtn.disabled    = false;
    saveBtn.textContent = '📄 Save as Draft';
    toast(e.message || 'Save failed', 'error');
  }
}

function closeCreateFromImagesDialog() {
  document.getElementById('createFromImagesOverlay').classList.remove('show');
}

(function _wireCfigDialog() {
  document.getElementById('cfigCloseBtn').addEventListener('click', closeCreateFromImagesDialog);
  document.getElementById('cfigPrompt').addEventListener('input', _cfigUpdateCounter);
  document.getElementById('cfigGenerateBtn').addEventListener('click', _cfigStartAnalysis);
  // "Edit & Regenerate" goes back to the setup screen so the user can tweak the prompt
  document.getElementById('cfigRegenerateBtn').addEventListener('click', () => {
    ['cfigFields','cfigError','cfigSaved'].forEach(id => { document.getElementById(id).style.display = 'none'; });
    document.getElementById('cfigRegenerateBtn').style.display = 'none';
    document.getElementById('cfigSaveBtn').style.display       = 'none';
    document.getElementById('cfigCloseBtn').textContent        = 'Cancel';
    document.getElementById('cfigSetupScreen').style.display   = 'block';
    document.getElementById('cfigGenerateBtn').style.display   = 'inline-flex';
  });
  document.getElementById('cfigSaveBtn').addEventListener('click', _saveCreateFromImages);
  document.getElementById('createFromImagesOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('createFromImagesOverlay')) closeCreateFromImagesDialog();
  });
})();

// -- WordPress XML Import -------------------------------------------------------
async function handleWpXmlFileSelect(file) {
  if (!file || !file.name.toLowerCase().endsWith('.xml')) {
    toast('Please select a .xml file', 'error'); return;
  }
  if (file.size > 100 * 1024 * 1024) {
    toast('File too large (max 100 MB)', 'error'); return;
  }
  document.getElementById('wpXmlPreview').style.display = 'none';
  document.getElementById('wpXmlParseProgress').style.display = 'flex';
  try {
    const form = new FormData();
    form.append('xmlFile', file);
    const r    = await fetch('/api/tools/parse-wordpress-xml', { method: 'POST', body: form });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Parse failed');
    state.wpXmlSession = data.sessionToken;
    state.wpXmlSummary = data.summary;
    renderWpXmlPreview(data.summary);
  } catch (e) {
    toast('Parse error: ' + e.message, 'error');
  } finally {
    document.getElementById('wpXmlParseProgress').style.display = 'none';
  }
}

function renderWpXmlPreview(summary) {
  const { published = 0, drafts = 0, pages = 0, media = {} } = summary;
  const { images = 0, videos = 0, other = 0 } = media;
  document.getElementById('wpXmlSummary').innerHTML = [
    published ? `<b>${published}</b> published post${published !== 1 ? 's' : ''}` : '',
    drafts    ? `<b>${drafts}</b> draft${drafts !== 1 ? 's' : ''}` : '',
    pages     ? `<b>${pages}</b> page${pages !== 1 ? 's' : ''}` : '',
    images    ? `<b>${images}</b> image${images !== 1 ? 's' : ''}` : '',
    videos    ? `<b>${videos}</b> video${videos !== 1 ? 's' : ''}` : '',
    other     ? `<b>${other}</b> other file${other !== 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' &nbsp;&#183;&nbsp; ');
  document.getElementById('wpXmlPreview').style.display = '';
  document.getElementById('wpXmlImportBtn').disabled = false;
}

async function startWpXmlImport() {
  if (!state.wpXmlSession) return;
  const options = {
    published:    document.getElementById('wpOptPublished').checked,
    drafts:       document.getElementById('wpOptDrafts').checked,
    pages:        document.getElementById('wpOptPages').checked,
    migrateMedia: document.getElementById('wpOptMedia').checked,
  };

  const overlay = document.getElementById('wpImportOverlay');
  document.getElementById('wpImportMediaLabel').textContent    = '0 / 0';
  document.getElementById('wpImportPostsLabel').textContent    = '0 / 0';
  document.getElementById('wpImportMediaBar').style.width      = '0%';
  document.getElementById('wpImportPostsBar').style.width      = '0%';
  document.getElementById('wpImportLog').innerHTML             = '';
  document.getElementById('wpImportDownloadBtn').style.display = 'none';
  document.getElementById('wpImportDoneBtn').style.display     = 'none';
  document.getElementById('wpImportCancelBtn').style.display   = '';
  overlay.classList.add('show');

  const abortCtrl   = new AbortController();
  state.wpImportAbort = abortCtrl;

  try {
    const _reqBody = { sessionToken: state.wpXmlSession, options,
                       testSlug: document.getElementById('wpTestSlug')?.value.trim() || null };
    console.log('[WP IMPORT] request body:', JSON.stringify(_reqBody));
    const r = await fetch('/api/tools/import-wordpress', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
      body:    JSON.stringify(_reqBody),
      signal:  abortCtrl.signal,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { _wpHandleEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      _wpAddLog('Import error: ' + e.message, 'error');
    } else {
      _wpAddLog('Import cancelled.', 'warn');
    }
  } finally {
    state.wpImportAbort = null;
    document.getElementById('wpImportCancelBtn').style.display   = 'none';
    document.getElementById('wpImportDoneBtn').style.display     = '';
    document.getElementById('wpImportDownloadBtn').style.display = '';
  }
}

function _wpHandleEvent(event) {
  const { type, current, total, message, imported, failed, mediaUploaded, mediaFailed } = event;
  if (type === 'media') {
    document.getElementById('wpImportMediaLabel').textContent = `${current} / ${total}`;
    document.getElementById('wpImportMediaBar').style.width   = `${total > 0 ? Math.round((current / total) * 100) : 0}%`;
    if (message) _wpAddLog(message, 'info');
  } else if (type === 'progress') {
    document.getElementById('wpImportPostsLabel').textContent = `${current} / ${total}`;
    document.getElementById('wpImportPostsBar').style.width   = `${total > 0 ? Math.round((current / total) * 100) : 0}%`;
    if (message) _wpAddLog(message, 'info');
  } else if (type === 'debug') {
    if (message) _wpAddLog(message, 'debug');
  } else if (type === 'info') {
    if (message) _wpAddLog(message, 'info');
  } else if (type === 'error') {
    if (message) _wpAddLog(message, 'error');
  } else if (type === 'complete') {
    const summary = [`Done -- ${imported} imported, ${failed} failed`];
    if (mediaUploaded != null) summary.push(`${mediaUploaded} media uploaded, ${mediaFailed} failed`);
    _wpAddLog(summary.join(' / '), 'success');
    document.getElementById('wpImportPostsBar').style.width = '100%';
  }
}

function _wpAddLog(msg, type) {
  const log  = document.getElementById('wpImportLog');
  const line = document.createElement('div');
  line.style.color = type === 'error' ? '#f87171' : type === 'success' ? '#4ade80' : type === 'warn' ? '#fbbf24' : type === 'debug' ? '#94a3b8' : 'inherit';
  if (type === 'debug') { line.style.fontFamily = 'monospace'; line.style.fontSize = '0.8rem'; }
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function cancelWpXmlImport() {
  if (state.wpImportAbort) { state.wpImportAbort.abort(); state.wpImportAbort = null; }
}

async function downloadWpImportLog() {
  if (!state.wpXmlSession) return;
  try {
    const r = await fetch(`/api/tools/import-wordpress-log/${state.wpXmlSession}`);
    if (!r.ok) throw new Error('Log not available');
    const blob = await r.blob();
    const cd   = r.headers.get('Content-Disposition') || '';
    const fn   = cd.match(/filename="([^"]+)"/)?.[1] || 'wp-import-log.json';
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fn; a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast('Could not download log: ' + e.message, 'error');
  }
}


// ╔══════════════════════════════════════════════════════════════════════════════
// ── Videos tab ──────────────────────────────────────────────────────────────
// ╚══════════════════════════════════════════════════════════════════════════════

let _videosTabInitialised = false;

function initVideosTab() {
  if (!_videosTabInitialised) {
    _videosTabInitialised = true;
    setupVideoListeners();
  }
  if (!state.videosLoaded) loadVideos();
}

function setupVideoListeners() {
  document.getElementById('videoSearchInput').addEventListener('input', applyVideoFilterSort);
  document.getElementById('videoSortSelect').addEventListener('change', applyVideoFilterSort);
  document.getElementById('videoRefreshBtn').addEventListener('click', () => { state.videosLoaded = false; loadVideos(); });

  // preview overlay controls
  document.getElementById('closeVideoPreview').addEventListener('click', closeVideoPreview);
  document.getElementById('videoPreviewOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('videoPreviewOverlay')) closeVideoPreview();
  });
  document.getElementById('videoPreviewCopyBtn').addEventListener('click', () => {
    if (state.videoPreviewTarget) copyToClipboard(state.videoPreviewTarget.url);
  });
  document.getElementById('videoPreviewRenameBtn').addEventListener('click', () => {
    if (state.videoPreviewTarget) { closeVideoPreview(); openVideoRenameModal(state.videoPreviewTarget); }
  });
  document.getElementById('videoPreviewDeleteBtn').addEventListener('click', () => {
    if (state.videoPreviewTarget) { closeVideoPreview(); openVideoDeleteModal(state.videoPreviewTarget); }
  });

  // delete overlay
  document.getElementById('videoDeleteCancelBtn').addEventListener('click', closeVideoDeleteModal);
  document.getElementById('videoDeleteConfirmBtn').addEventListener('click', confirmVideoDelete);
  document.getElementById('videoDeleteOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('videoDeleteOverlay')) closeVideoDeleteModal();
  });

  // rename overlay
  document.getElementById('videoRenameCancelBtn').addEventListener('click', closeVideoRenameModal);
  document.getElementById('videoRenameConfirmBtn').addEventListener('click', confirmVideoRename);
  document.getElementById('videoRenameOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('videoRenameOverlay')) closeVideoRenameModal();
  });
  document.getElementById('videoRenameInput').addEventListener('input', () => {
    document.getElementById('videoRenameError').textContent = '';
  });
}

async function loadVideos() {
  const grid    = document.getElementById('videoGrid');
  const loading = document.getElementById('videoLoading');
  const empty   = document.getElementById('videoEmpty');
  const banner  = document.getElementById('videoFsMountBanner');

  grid.innerHTML = '';
  loading.style.display = 'flex';
  empty.style.display   = 'none';
  banner.style.display  = 'none';

  try {
    const r = await api('/api/videos');
    if (!r.ok) {
      if (r.status === 503) { banner.style.display = 'block'; }
      throw new Error(await r.text());
    }
    const data = await r.json();
    if (!data.fsMounted) { banner.style.display = 'block'; }
    state.allVideos      = data.videos || [];
    state.filteredVideos = [...state.allVideos];
    state.videosLoaded   = true;
    applyVideoFilterSort();
  } catch(e) {
    toast('Failed to load videos: ' + e.message, 'error');
  } finally {
    loading.style.display = 'none';
  }
}

function applyVideoFilterSort() {
  applyListFilterSort(state.allVideos, 'videoSearchInput', 'videoSortSelect', 'name',
    items => { state.filteredVideos = items; renderVideoGrid(); });
}

function renderVideoGrid() {
  const grid  = document.getElementById('videoGrid');
  const empty = document.getElementById('videoEmpty');
  const count = document.getElementById('videoCount');

  grid.innerHTML = '';
  const n = state.filteredVideos.length;
  count.textContent = n === 0 ? '' : `${n} video${n !== 1 ? 's' : ''}`;

  if (n === 0) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';

  state.filteredVideos.forEach(v => {
    grid.appendChild(buildVideoCard(v));
  });

  ensureUsageBadges();
}

function buildVideoCard(video) {
  const thumbSrc = video.thumbUrl
    ? `/api/videos/thumbnail?videoUrl=${encodeURIComponent(video.url)}`
    : null;
  const date = new Date(video.mtime).toLocaleDateString();
  const size = formatBytes(video.size);

  const card = document.createElement('div');
  card.className = 'image-card';
  card.dataset.mediaUrl = video.url;
  card.innerHTML = `
    <div class="video-thumb-wrap">
      <div class="card-select-wrap"><input type="checkbox" class="card-checkbox" title="Select video"></div>
      ${thumbSrc
        ? `<img class="image-thumb" src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(video.name)}" loading="lazy">`
        : `<div class="video-no-thumb"><span style="font-size:40px">&#127916;</span></div>`}
      <div class="video-play-overlay"><span class="video-play-icon">&#9654;</span></div>
    </div>
    <div class="image-card-body">
      <div class="image-filename" title="${escapeHtml(video.name)}">${escapeHtml(video.name)}</div>
      <div class="image-meta"><span>${date}</span><span>${size}</span></div>
      <span class="usage-badge" style="margin-top:2px">&#8230;</span>
    </div>
    <div class="card-actions">
      <button class="card-btn card-btn-copy"   data-action="copy-url">&#128279; URL</button>
      <button class="card-btn card-btn-copy"   data-action="copy-md">Md</button>
      <button class="card-btn card-btn-copy"   data-action="copy-html">HTML</button>
      <button class="card-btn card-btn-rename" data-action="rename">&#10002; Rename</button>
      <button class="card-btn card-btn-delete" data-action="delete">&#128465; Delete</button>
    </div>
  `;

  if (thumbSrc) {
    card.querySelector('.image-thumb').onerror = function() {
      const wrap = this.closest('.video-thumb-wrap');
      wrap.innerHTML = `<div class="video-no-thumb"><span style="font-size:40px">&#127916;</span></div>
                        <div class="video-play-overlay"><span class="video-play-icon">&#9654;</span></div>`;
    };
  }

  card.querySelector('.video-thumb-wrap').addEventListener('click', () => {
    openMediaPreview(video, 'video');
  });
  card.querySelector('.card-select-wrap').addEventListener('click', e => e.stopPropagation());
  card.querySelector('.card-checkbox').addEventListener('change', e => {
    toggleVideoCardSelection(card, video, e.target.checked);
  });
  card.querySelectorAll('.card-btn').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const name = video.name || video.url.split('/').pop();
    if (btn.dataset.action === 'copy-url')  copyToClipboard(video.url);
    if (btn.dataset.action === 'copy-md')   { copyText(`[${name}](${video.url})`);                          toast('Markdown copied!', 'success'); }
    if (btn.dataset.action === 'copy-html') { copyText(`<video src="${video.url}" controls></video>`);       toast('HTML copied!',     'success'); }
    if (btn.dataset.action === 'rename')    openVideoRenameModal(video);
    if (btn.dataset.action === 'delete')    openVideoDeleteModal(video);
  }));
  return card;
}
function mkBtn(icon, title, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.className = 'btn btn-ghost btn-sm' + (extraClass ? ' ' + extraClass : '');
  b.title = title;
  b.textContent = icon;
  b.addEventListener('click', onClick);
  return b;
}

// ── Video preview ──

function openVideoPreview(video) {
  state.videoPreviewTarget = video;
  document.getElementById('videoPreviewTitle').textContent = video.name;
  const player = document.getElementById('videoPreviewPlayer');
  player.src = video.url;
  document.getElementById('videoPreviewMeta').textContent =
    formatBytes(video.size) + ' · ' + new Date(video.mtime).toLocaleString();
  document.getElementById('videoPreviewOverlay').classList.add('show');
}

function closeVideoPreview() {
  const player = document.getElementById('videoPreviewPlayer');
  player.pause();
  player.src = '';
  state.videoPreviewTarget = null;
  document.getElementById('videoPreviewOverlay').classList.remove('show');
}

// ── Video delete ──

const videoDeleteModal = createModal(
  { overlay: 'videoDeleteOverlay', confirmBtn: 'videoDeleteConfirmBtn' },
  {
    onOpen(video) {
      document.getElementById('videoDeleteFilename').textContent = video.name;
      document.getElementById('videoDeleteUsageWarning').style.display = 'none';
    },
    async onConfirm(video) {
      const params = new URLSearchParams({ videoUrl: video.url });
      const r = await api(`/api/videos/file?${params}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Delete failed: ' + await r.text());
      toast('Video deleted', 'success');
      state.allVideos = state.allVideos.filter(v => v.url !== video.url);
      applyVideoFilterSort();
    },
  }
);
function openVideoDeleteModal(video)  { videoDeleteModal.open(video); }
function closeVideoDeleteModal()      { videoDeleteModal.close(); }
async function confirmVideoDelete()   { await videoDeleteModal.confirm(); }

const videoRenameModal = createModal(
  { overlay: 'videoRenameOverlay', confirmBtn: 'videoRenameConfirmBtn' },
  {
    onOpen(video) {
      document.getElementById('videoRenameCurrentName').textContent = video.name;
      document.getElementById('videoRenameInput').value = video.name;
      document.getElementById('videoRenameError').textContent = '';
      document.getElementById('videoRenamePostsNote').style.display = 'none';
      setTimeout(() => document.getElementById('videoRenameInput').select(), 50);
    },
    async onConfirm(video) {
      const newName = document.getElementById('videoRenameInput').value.trim();
      const noteEl  = document.getElementById('videoRenamePostsNote');
      noteEl.textContent = 'Renaming and updating posts…';
      noteEl.style.display = 'block';
      try {
        const r = await api('/api/videos/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoUrl: video.url, newFilename: newName }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || r.statusText);
        const updated = data.postsUpdated || 0;
        toast(`Renamed. ${updated} post${updated !== 1 ? 's' : ''} updated.`, 'success');
        state.videosLoaded = false;
        loadVideos();
      } finally {
        noteEl.style.display = 'none';
      }
    },
  }
);
function openVideoRenameModal(video)  { videoRenameModal.open(video); }
function closeVideoRenameModal()      { videoRenameModal.close(); }
function confirmVideoRename() {
  const video   = videoRenameModal.getTarget();
  const newName = document.getElementById('videoRenameInput').value.trim();
  const errEl   = document.getElementById('videoRenameError');
  if (!newName)              { errEl.textContent = 'Please enter a filename.'; return; }
  if (newName === video.name) { videoRenameModal.close(); return; }
  errEl.textContent = '';
  return videoRenameModal.confirm();
}

// ╔══════════════════════════════════════════════════════════════════════════════
// ── Files tab ───────────────────────────────────────────────────────────────
// ╚══════════════════════════════════════════════════════════════════════════════

let _filesTabInitialised = false;

function initFilesTab() {
  if (!_filesTabInitialised) {
    _filesTabInitialised = true;
    setupFilesListeners();
  }
  if (!state.filesLoaded) loadFiles();
}

function setupFilesListeners() {
  document.getElementById('filesSearchInput').addEventListener('input', applyFileFilterSort);
  document.getElementById('filesSortSelect').addEventListener('change', applyFileFilterSort);
  document.getElementById('filesRefreshBtn').addEventListener('click', () => { state.filesLoaded = false; loadFiles(); });

  // delete overlay
  document.getElementById('fileDeleteCancelBtn').addEventListener('click', closeFileDeleteModal);
  document.getElementById('fileDeleteConfirmBtn').addEventListener('click', confirmFileDelete);
  document.getElementById('fileDeleteOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('fileDeleteOverlay')) closeFileDeleteModal();
  });

  // rename overlay
  document.getElementById('fileRenameCancelBtn').addEventListener('click', closeFileRenameModal);
  document.getElementById('fileRenameConfirmBtn').addEventListener('click', confirmFileRename);
  document.getElementById('fileRenameOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('fileRenameOverlay')) closeFileRenameModal();
  });
  document.getElementById('fileRenameInput').addEventListener('input', () => {
    document.getElementById('fileRenameError').textContent = '';
  });
}

async function loadFiles() {
  const state_  = document.getElementById('filesState');
  const empty   = document.getElementById('filesEmpty');
  const banner  = document.getElementById('filesFsMountBanner');

  state_.style.display  = 'flex';
  empty.style.display   = 'none';
  banner.style.display  = 'none';

  try {
    const r = await api('/api/files');
    if (!r.ok) {
      if (r.status === 503) { banner.style.display = 'block'; }
      throw new Error(await r.text());
    }
    const data = await r.json();
    if (!data.fsMounted) { banner.style.display = 'block'; }
    state.allFiles    = data.files || [];
    state.filesLoaded = true;
    applyFileFilterSort();
  } catch(e) {
    toast('Failed to load files: ' + e.message, 'error');
  } finally {
    state_.style.display = 'none';
  }
}

function applyFileFilterSort() {
  applyListFilterSort(state.allFiles, 'filesSearchInput', 'filesSortSelect', 'name',
    items => { state.filteredFiles = items; renderFileList(); });
}

function renderFileList() {
  const grid  = document.getElementById('filesGrid');
  const empty = document.getElementById('filesEmpty');
  const count = document.getElementById('filesCount');

  grid.innerHTML = '';
  const n = state.filteredFiles.length;
  count.textContent = n === 0 ? '' : `${n} file${n !== 1 ? 's' : ''}`;

  if (n === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  state.filteredFiles.forEach(f => grid.appendChild(buildFileCard(f)));

  ensureUsageBadges();
}

function buildFileCard(file) {
  const ext  = (file.name.split('.').pop() || '').toLowerCase();
  const icon = getFileIcon(ext);
  const date = new Date(file.mtime).toLocaleDateString();
  const size = formatBytes(file.size);

  const card = document.createElement('div');
  card.className = 'image-card';
  card.dataset.mediaUrl = file.url;
  card.innerHTML = `
    <div class="file-thumb-wrap" style="cursor:pointer">
      <div class="card-select-wrap"><input type="checkbox" class="card-checkbox" title="Select file"></div>
      <div class="file-thumb-icon">${icon}</div>
      ${ext ? `<span class="file-ext-badge">${escapeHtml(ext.toUpperCase())}</span>` : ''}
    </div>
    <div class="image-card-body">
      <div class="image-filename" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="image-meta"><span>${date}</span><span>${size}</span></div>
      <span class="usage-badge" style="margin-top:2px">&#8230;</span>
    </div>
    <div class="card-actions">
      <button class="card-btn card-btn-dl"     data-action="download">&#11015; DL</button>
      <button class="card-btn card-btn-copy"   data-action="copy-url">&#128279; URL</button>
      <button class="card-btn card-btn-copy"   data-action="copy-md">Md</button>
      <button class="card-btn card-btn-copy"   data-action="copy-html">HTML</button>
      <button class="card-btn card-btn-rename" data-action="rename">&#10002; Rename</button>
      <button class="card-btn card-btn-delete" data-action="delete">&#128465; Delete</button>
    </div>
  `;

  card.querySelector('.file-thumb-wrap').addEventListener('click', () => {
    openMediaPreview(file, 'file');
  });
  card.querySelector('.card-select-wrap').addEventListener('click', e => e.stopPropagation());
  card.querySelector('.card-checkbox').addEventListener('change', e => {
    toggleFileCardSelection(card, file, e.target.checked);
  });
  card.querySelectorAll('.card-btn').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    if (btn.dataset.action === 'download')  downloadFile(file);
    if (btn.dataset.action === 'copy-url')  copyToClipboard(file.url);
    if (btn.dataset.action === 'copy-md')   { copyText(`[${file.name}](${file.url})`);                      toast('Markdown copied!', 'success'); }
    if (btn.dataset.action === 'copy-html') { copyText(`<a href="${file.url}">${file.name}</a>`);            toast('HTML copied!',     'success'); }
    if (btn.dataset.action === 'rename')    openFileRenameModal(file);
    if (btn.dataset.action === 'delete')    openFileDeleteModal(file);
  }));
  return card;
}
function getFileIcon(ext) {
  const map = {
    pdf: '📄', zip: '🗜', gz: '🗜', tar: '🗜', rar: '🗜',
    doc: '📝', docx: '📝', odt: '📝',
    xls: '📊', xlsx: '📊', ods: '📊', csv: '📊',
    ppt: '📊', pptx: '📊', odp: '📊',
    mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵',
    mp4: '🎬', mov: '🎬', avi: '🎬', webm: '🎬',
    jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼', svg: '🖼',
    txt: '📄', md: '📄', json: '📄', xml: '📄',
    js: '💻', ts: '💻', css: '💻', html: '💻',
  };
  return map[ext] || '📎';
}

async function downloadFile(file) {
  try {
    const r = await api(`/api/files/download?fileUrl=${encodeURIComponent(file.url)}`);
    if (!r.ok) { toast('Download failed', 'error'); return; }
    const blob = await r.blob();
    const cd   = r.headers.get('Content-Disposition') || '';
    const fn   = cd.match(/filename="([^"]+)"/)?.[1] || file.name;
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fn; a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (e.message !== 'Unauthorized') toast('Download failed: ' + e.message, 'error');
  }
}

// ── File delete ──

const fileDeleteModal = createModal(
  { overlay: 'fileDeleteOverlay', confirmBtn: 'fileDeleteConfirmBtn' },
  {
    onOpen(file) {
      document.getElementById('fileDeleteFilename').textContent = file.name;
    },
    async onConfirm(file) {
      const params = new URLSearchParams({ fileUrl: file.url });
      const r = await api(`/api/files/file?${params}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Delete failed: ' + await r.text());
      toast('File deleted', 'success');
      state.allFiles = state.allFiles.filter(f => f.url !== file.url);
      applyFileFilterSort();
    },
  }
);
function openFileDeleteModal(file)  { fileDeleteModal.open(file); }
function closeFileDeleteModal()     { fileDeleteModal.close(); }
async function confirmFileDelete()  { await fileDeleteModal.confirm(); }

const fileRenameModal = createModal(
  { overlay: 'fileRenameOverlay', confirmBtn: 'fileRenameConfirmBtn' },
  {
    onOpen(file) {
      document.getElementById('fileRenameCurrentName').textContent = file.name;
      document.getElementById('fileRenameInput').value = file.name;
      document.getElementById('fileRenameError').textContent = '';
      setTimeout(() => document.getElementById('fileRenameInput').select(), 50);
    },
    async onConfirm(file) {
      const newName = document.getElementById('fileRenameInput').value.trim();
      const r = await api('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUrl: file.url, newFilename: newName }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      toast('File renamed', 'success');
      state.filesLoaded = false;
      loadFiles();
    },
  }
);
function openFileRenameModal(file)  { fileRenameModal.open(file); }
function closeFileRenameModal()     { fileRenameModal.close(); }
function confirmFileRename() {
  const file    = fileRenameModal.getTarget();
  const newName = document.getElementById('fileRenameInput').value.trim();
  const errEl   = document.getElementById('fileRenameError');
  if (!newName)            { errEl.textContent = 'Please enter a filename.'; return; }
  if (newName === file.name) { fileRenameModal.close(); return; }
  errEl.textContent = '';
  return fileRenameModal.confirm();
}

function copyToClipboard(text) {
  copyText(text);
  toast('Copied to clipboard', 'success');
}

// ── Insert Image into Post ────────────────────────────────────────────────────

function openInsertImageModal() {
  const img = state.selectedImages[0];
  if (!img) return;

  const sel = document.getElementById('insertPostSelect');
  sel.innerHTML = '<option value="">— select a post —</option>';

  const fill = (posts) => {
    posts.forEach(p => {
      const opt = document.createElement('option');
      opt.value         = p.id;
      opt.dataset.type  = p._type === 'page' ? 'pages' : 'posts';
      opt.textContent   = `${p._type === 'page' ? '[Page] ' : ''}${p.title || '(untitled)'}`;
      sel.appendChild(opt);
    });
  };

  if (state.postsData.length > 0) {
    fill(state.postsData);
  } else {
    loadPosts().then(() => fill(state.postsData));
  }

  // Pre-fill alt text from filename
  const filename = img.filename || img.url.split('/').pop() || '';
  document.getElementById('insertAltText').value =
    filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  document.getElementById('insertCaption').value = '';

  document.getElementById('insertImageOverlay').classList.add('show');
}

async function insertImageIntoPost() {
  const img      = state.selectedImages[0];
  const sel      = document.getElementById('insertPostSelect');
  const postId   = sel.value;
  const postType = sel.selectedOptions[0]?.dataset.type || 'posts';

  if (!postId) { toast('Please select a post.', 'warning'); return; }

  const btn = document.getElementById('insertConfirmBtn');
  btn.disabled    = true;
  btn.textContent = 'Inserting…';

  try {
    const res  = await api('/api/media/insert-into-post', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrl:  img.url,
        postId,
        postType,
        cardWidth: document.getElementById('insertCardWidth').value,
        position:  document.getElementById('insertPosition').value,
        alt:       document.getElementById('insertAltText').value.trim(),
        caption:   document.getElementById('insertCaption').value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    toast('Image inserted into post ✓', 'success');
    document.getElementById('insertImageOverlay').classList.remove('show');
  } catch (e) {
    toast(`Insert failed: ${e.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Insert';
  }
}

// ── Insert Gallery into Post ──────────────────────────────────────────────────

function _wireDragSort(container) {
  let dragging = null;

  container.addEventListener('dragstart', e => {
    dragging = e.target.closest('.gallery-order-thumb');
    if (dragging) e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.gallery-order-thumb');
    if (target && target !== dragging) {
      const rect = target.getBoundingClientRect();
      const mid  = rect.left + rect.width / 2;
      if (e.clientX < mid) container.insertBefore(dragging, target);
      else                 target.after(dragging);
    }
  });

  container.addEventListener('dragend', () => { dragging = null; });
}

function openInsertGalleryModal() {
  if (state.selectedImages.length < 2) return;

  const sel = document.getElementById('insertGalleryPostSelect');
  sel.innerHTML = '<option value="">— select a post —</option>';

  const fill = (posts) => {
    posts.forEach(p => {
      const opt = document.createElement('option');
      opt.value        = p.id;
      opt.dataset.type = p._type === 'page' ? 'pages' : 'posts';
      opt.textContent  = `${p._type === 'page' ? '[Page] ' : ''}${p.title || '(untitled)'}`;
      sel.appendChild(opt);
    });
  };

  if (state.postsData.length > 0) {
    fill(state.postsData);
  } else {
    loadPosts().then(() => fill(state.postsData));
  }

  // Render sortable thumbnail strip
  const strip = document.getElementById('galleryOrderStrip');
  strip.innerHTML = '';
  state.selectedImages.forEach((img, i) => {
    const thumb = document.createElement('div');
    thumb.className   = 'gallery-order-thumb';
    thumb.draggable   = true;
    thumb.dataset.idx = i;
    thumb.style.cssText = 'cursor:grab;text-align:center;font-size:11px;color:var(--text-muted);width:72px';
    thumb.innerHTML = `<img src="${escapeHtml(img.url)}" alt=""
      style="width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--border);display:block;margin:0 auto 4px">
      <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:72px">${escapeHtml(img.filename || img.url.split('/').pop())}</span>`;
    strip.appendChild(thumb);
  });
  _wireDragSort(strip);

  document.getElementById('galleryCaption').value = '';
  document.getElementById('insertGalleryOverlay').classList.add('show');
}

async function insertGallery() {
  const sel      = document.getElementById('insertGalleryPostSelect');
  const postId   = sel.value;
  const postType = sel.selectedOptions[0]?.dataset.type || 'posts';

  if (!postId) { toast('Please select a post.', 'warning'); return; }

  // Read image order from the sortable strip
  const strip       = document.getElementById('galleryOrderStrip');
  const orderedUrls = [...strip.querySelectorAll('.gallery-order-thumb')]
    .map(el => state.selectedImages[parseInt(el.dataset.idx)].url);

  const btn = document.getElementById('insertGalleryConfirmBtn');
  btn.disabled    = true;
  btn.textContent = 'Inserting…';

  try {
    const res = await api('/api/media/insert-into-post', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode:      'gallery',
        imageUrls: orderedUrls,
        postId,
        postType,
        position: document.getElementById('insertGalleryPosition').value,
        caption:  document.getElementById('galleryCaption').value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    toast(`Gallery with ${orderedUrls.length} images inserted ✓`, 'success');
    document.getElementById('insertGalleryOverlay').classList.remove('show');
  } catch (e) {
    toast(`Gallery insert failed: ${e.message}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Insert Gallery';
  }
}

// ── HTML Live Editor ───────────────────────────────────────────────────────────────────────────
function initHtmlEditorTab() {
  const ta          = document.getElementById('heTextarea');
  const lineNums    = document.getElementById('heLineNums');
  const frame       = document.getElementById('hePreview');
  const statusPos   = document.getElementById('heStatusPos');
  const statusChars = document.getElementById('heStatusChars');
  const statusValid = document.getElementById('heStatusValid');

  if (ta._heInit) return; // already wired
  ta._heInit = true;

  // ── Snippet templates ───────────────────────────────────────────────────────────────────
  const SNIPPETS = {
    'two-col':
`<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;font-family:Georgia,serif">
  <div>
    <h2 style="font-size:1.25rem;font-weight:700;margin-bottom:12px">Heading</h2>
    <p style="color:#374151;line-height:1.7">Your first column text goes here.</p>
  </div>
  <div>
    <img src="" alt="Image" style="width:100%;border-radius:8px;object-fit:cover" />
  </div>
</div>`,

    'img-left':
`<div style="display:grid;grid-template-columns:240px 1fr;gap:24px;align-items:start;font-family:Georgia,serif">
  <div>
    <img src="" alt="Portrait" style="width:100%;border-radius:8px;object-fit:cover" />
  </div>
  <div>
    <h2 style="font-size:1.25rem;font-weight:700;margin-bottom:12px">Heading</h2>
    <p style="color:#374151;line-height:1.7">Your content alongside the image.</p>
  </div>
</div>`,

    'img-right':
`<div style="display:grid;grid-template-columns:1fr 240px;gap:24px;align-items:start;font-family:Georgia,serif">
  <div>
    <h2 style="font-size:1.25rem;font-weight:700;margin-bottom:12px">Heading</h2>
    <p style="color:#374151;line-height:1.7">Your content alongside the image.</p>
  </div>
  <div>
    <img src="" alt="Portrait" style="width:100%;border-radius:8px;object-fit:cover" />
  </div>
</div>`,

    'callout':
`<div style="border-left:4px solid #22c55e;background:#f0fdf4;border-radius:6px;padding:16px 20px;font-family:Georgia,serif">
  <p style="margin:0;font-weight:600;color:#166534;margin-bottom:6px">ℹ️ Note</p>
  <p style="margin:0;color:#15803d;line-height:1.6">Your callout message goes here.</p>
</div>`,

    'table':
`<table style="width:100%;border-collapse:collapse;font-family:Georgia,serif;font-size:14px">
  <thead>
    <tr style="background:#f3f4f6">
      <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #e5e7eb;font-weight:600">Column 1</th>
      <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #e5e7eb;font-weight:600">Column 2</th>
      <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #e5e7eb;font-weight:600">Column 3</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Row 1, A</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Row 1, B</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Row 1, C</td>
    </tr>
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Row 2, A</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Row 2, B</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Row 2, C</td>
    </tr>
  </tbody>
</table>`,

    'badge':
`<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600;background:#ede9fe;color:#5b21b6;border:1px solid #c4b5fd;font-family:-apple-system,sans-serif">BC 2024 Wave 2</span>`,

    'tip':
`<div style="border-left:4px solid #f59e0b;background:#fffbeb;border-radius:6px;padding:16px 20px;font-family:Georgia,serif">
  <p style="margin:0;font-weight:600;color:#92400e;margin-bottom:6px">💡 Tip</p>
  <p style="margin:0;color:#92400e;line-height:1.6">Your tip text goes here.</p>
</div>`,

    'warning':
`<div style="border-left:4px solid #ef4444;background:#fef2f2;border-radius:6px;padding:16px 20px;font-family:Georgia,serif">
  <p style="margin:0;font-weight:600;color:#991b1b;margin-bottom:6px">⚠️ Warning</p>
  <p style="margin:0;color:#991b1b;line-height:1.6">Your warning message goes here.</p>
</div>`,
  };

  // ── Preview wrappers ───────────────────────────────────────────────────────────────────
  const PREVIEW_WRAP = {
    raw:   html => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:16px;font-family:-apple-system,sans-serif;line-height:1.6}</style></head><body>${html}</body></html>`,
    ghost: html => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;background:#fff;font-family:Georgia,serif;color:#1f2937;line-height:1.75}.gh{max-width:720px;margin:32px auto;padding:0 24px}</style></head><body><div class="gh">${html}</div></body></html>`,
    dark:  html => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;background:#111827;color:#f3f4f6;font-family:Georgia,serif;line-height:1.75}.gh{max-width:720px;margin:32px auto;padding:0 24px}</style></head><body><div class="gh">${html}</div></body></html>`,
  };

  let currentMode = 'raw';

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────
  function updateLineNumbers() {
    const count = ta.value.split('\n').length;
    lineNums.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  }

  function updatePreview() {
    frame.srcdoc = PREVIEW_WRAP[currentMode](ta.value);
  }

  function updateStatus() {
    const val   = ta.value;
    const lines = val.substring(0, ta.selectionStart).split('\n');
    statusPos.textContent   = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
    statusChars.textContent = `${val.length} chars`;
    if (!val.trim()) {
      statusValid.textContent = '';
    } else {
      const open  = (val.match(/</g)  || []).length;
      const close = (val.match(/>/g)  || []).length;
      if (open !== close) {
        statusValid.textContent  = '⚠ unclosed tag?';
        statusValid.style.color  = 'var(--warning)';
      } else {
        statusValid.textContent  = '✓ ready';
        statusValid.style.color  = 'var(--success)';
      }
    }
  }

  function insertAtCursor(text) {
    const start  = ta.selectionStart;
    const before = ta.value.substring(0, start);
    const after  = ta.value.substring(ta.selectionEnd);
    const insert = (before && !before.endsWith('\n')) ? '\n' + text : text;
    ta.value = before + insert + after;
    ta.selectionStart = ta.selectionEnd = start + insert.length;
    ta.focus();
    updateLineNumbers();
    updatePreview();
    updateStatus();
  }

  // ── Events ───────────────────────────────────────────────────────────────────────────────
  ta.addEventListener('input',  () => { updateLineNumbers(); updatePreview(); updateStatus(); });
  ta.addEventListener('click',  updateStatus);
  ta.addEventListener('keyup',  updateStatus);
  ta.addEventListener('scroll', () => { lineNums.scrollTop = ta.scrollTop; });

  ta.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const start = ta.selectionStart;
    ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = start + 2;
    updateLineNumbers();
    updatePreview();
    updateStatus();
  });

  document.querySelectorAll('.he-snippet').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = SNIPPETS[btn.dataset.snippet];
      if (s) insertAtCursor(s);
    });
  });

  document.querySelectorAll('.he-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.he-mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      updatePreview();
    });
  });

  document.getElementById('heCopyBtn').addEventListener('click', async () => {
    const html = ta.value;
    if (!html.trim()) { toast('Nothing to copy', 'warning'); return; }
    try {
      await navigator.clipboard.writeText(html);
      toast('HTML copied to clipboard ✓', 'success');
    } catch {
      toast('Copy failed — use Ctrl+A then Ctrl+C', 'error');
    }
  });

  document.getElementById('heClearBtn').addEventListener('click', () => {
    if (!ta.value.trim()) return;
    if (!confirm('Clear the editor? This cannot be undone.')) return;
    ta.value = '';
    updateLineNumbers();
    updatePreview();
    updateStatus();
    ta.focus();
  });

  // ── Initial render ───────────────────────────────────────────────────────────────────
  updateLineNumbers();
  updatePreview();
  updateStatus();
}
