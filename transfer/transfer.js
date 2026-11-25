(async () => {
  const element = id => document.getElementById(`transfer-${id}`);
  const notice = element('notice');
  const login = element('login');
  const workspace = element('workspace');
  const form = element('form');
  const input = element('input');
  const label = element('label');
  const status = element('status');
  const cancel = element('cancel');
  const list = element('list');
  const template = element('entry');
  const fileForm = element('file-form');
  const fileInput = element('file');
  const fileStatus = element('file-status');
  const quotaText = element('quota-text');
  const quotaMeter = element('quota-meter');
  const bucket = 'gdblog-transfer-files';
  const byteLimit = 40_000_000;
  const totalBytes = 1_000_000_000;
  const chunkSize = 6 * 1024 * 1024;
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const fields = 'id,text,created_at,updated_at';
  let entries = [];
  let files = [];
  let editing = null;
  let newDraft = '';
  let busy = false;
  let account = null;
  let client;
  let uploadEndpoint;
  let apiKey;

  try {
    const response = await fetch('./sync-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load sync config');
    const { url, publishableKey } = await response.json();
    if (!url || !publishableKey) {
      notice.textContent = '随手传正在配置云端同步。';
      return;
    }
    const endpoint = new URL(url);
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (!publishableKey.startsWith('sb_publishable_') || (!isLocal && endpoint.protocol !== 'https:')) {
      throw new Error('Invalid sync config');
    }
    client = window.supabase.createClient(endpoint.origin, publishableKey, {
      auth: { storage: sessionStorage, storageKey: 'gdblog.transfer.auth', detectSessionInUrl: false },
    });
    apiKey = publishableKey;
    if (endpoint.hostname.endsWith('.supabase.co')) {
      endpoint.hostname = endpoint.hostname.replace(/\.supabase\.co$/, '.storage.supabase.co');
    }
    uploadEndpoint = new URL('/storage/v1/upload/resumable', endpoint).href;
  } catch {
    notice.textContent = '随手传连接失败，请刷新页面重试。';
    return;
  }

  const records = () => client.from('transfer_entries');
  const storage = client.storage.from(bucket);

  function formatBytes(bytes) {
    if (bytes >= 1e9) return `${numberFormat.format(bytes / 1e9)} GB`;
    if (bytes >= 1e6) return `${numberFormat.format(bytes / 1e6)} MB`;
    if (bytes >= 1e3) return `${numberFormat.format(bytes / 1e3)} KB`;
    return `${bytes} B`;
  }

  function showQuota(bytes) {
    quotaMeter.hidden = bytes === null;
    if (bytes === null) {
      quotaText.textContent = '无法读取剩余额度，请刷新记录。';
      return;
    }
    quotaMeter.value = Math.min(bytes, totalBytes);
    quotaText.textContent = `剩余 ${formatBytes(Math.max(0, totalBytes - bytes))} · 总额度 1 GB`;
  }

  function render() {
    const timeline = [...entries, ...files].sort((a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id));
    element('count').textContent = `${timeline.length} 条`;
    element('empty').hidden = timeline.length > 0;
    list.replaceChildren();
    for (const entry of timeline) {
      const row = template.content.firstElementChild.cloneNode(true);
      const isFile = 'path' in entry;
      row.dataset.id = entry.id;
      row.dataset.kind = isFile ? 'file' : 'text';
      row.querySelector('.transfer-entry-content').textContent = isFile ? entry.filename : entry.text;
      row.querySelector('.transfer-entry-date').textContent = isFile
        ? `上传于 ${dateFormat.format(new Date(entry.created_at))} · ${formatBytes(entry.byte_size)}`
        : `修改于 ${dateFormat.format(new Date(entry.updated_at))}`;
      row.querySelector('[data-action="edit"]').hidden = isFile;
      row.querySelector('[data-action="copy"]').hidden = isFile;
      row.querySelector('[data-action="download"]').hidden = !isFile;
      list.append(row);
    }
  }

  function finishEditing() {
    input.value = editing ? newDraft : '';
    editing = null;
    newDraft = '';
    label.textContent = '新内容';
    cancel.hidden = true;
  }

  function showAccount(user) {
    account = user?.id ?? null;
    notice.textContent = user ? '云端同步 · 仅当前账号可见' : '用同一个账号登录，在不同电脑上接着编辑。';
    element('account-email').textContent = user?.email ?? '';
    login.hidden = Boolean(user);
    workspace.hidden = !user;
    if (!user) {
      entries = [];
      files = [];
      finishEditing();
      input.value = '';
      status.textContent = '';
      fileForm.reset();
      fileStatus.textContent = '';
      quotaText.textContent = '正在读取文件额度…';
      quotaMeter.hidden = true;
      render();
    }
  }

  async function readTimeline(query) {
    const next = [];
    const pageSize = 250;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await query()
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      next.push(...data);
      if (data.length < pageSize) return next;
    }
  }

  async function readFileUsage() {
    const { data, error } = await client.rpc('transfer_file_usage');
    if (error) throw error;
    return data;
  }

  async function refreshFiles() {
    const owner = account;
    try {
      const [next, usedBytes] = await Promise.all([
        readTimeline(() => client.rpc('transfer_list_files')),
        readFileUsage(),
      ]);
      if (owner !== account) return false;
      files = next;
      showQuota(usedBytes);
      render();
      return true;
    } catch {
      if (owner === account) showQuota(null);
      return false;
    }
  }

  async function refresh() {
    const owner = account;
    const [next] = await Promise.all([
      readTimeline(() => records().select(fields)),
      refreshFiles(),
    ]);
    if (owner !== account) return;
    entries = next;
    render();
  }

  async function uploadFile(file, owner) {
    const path = `${owner}/${crypto.randomUUID()}`;
    const metadata = { original_name: file.name };
    const contentType = file.type || 'application/octet-stream';
    if (file.size <= chunkSize) {
      const { error } = await storage.upload(path, file, { contentType, metadata });
      if (error) throw error;
      return;
    }

    await new Promise((resolve, reject) => {
      const upload = new window.tus.Upload(file, {
        endpoint: uploadEndpoint,
        chunkSize,
        retryDelays: [0, 1000, 3000, 6000, 12000],
        headers: { apikey: apiKey },
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        fingerprint: () => Promise.resolve(JSON.stringify([
          'gdblog-transfer', uploadEndpoint, owner, file.name, file.size, file.lastModified,
        ])),
        metadata: { bucketName: bucket, objectName: path, contentType, metadata: JSON.stringify(metadata) },
        onBeforeRequest: async request => {
          const { data, error } = await client.auth.getSession();
          if (error || data.session?.user.id !== owner) throw new Error('Upload needs an active session');
          request.setHeader('Authorization', `Bearer ${data.session.access_token}`);
        },
        onProgress: (sent, total) => {
          if (owner === account) fileStatus.textContent = `上传中 ${Math.round(sent / total * 100)}%`;
        },
        onError: reject,
        onSuccess: resolve,
      });
      upload.findPreviousUploads().then(previous => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      }).catch(reject);
    });
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]?.size > byteLimit) {
      fileInput.value = '';
      fileStatus.textContent = '这个文件超过 40 MB，请选择更小的文件。';
    } else {
      fileStatus.textContent = '';
    }
  });

  fileForm.addEventListener('submit', event => {
    event.preventDefault();
    const file = fileInput.files[0];
    const owner = account;
    if (!file || !owner || busy) return;
    if (file.size > byteLimit) {
      fileStatus.textContent = '这个文件超过 40 MB，请选择更小的文件。';
      return;
    }
    void perform(event.submitter, async () => {
      fileInput.disabled = true;
      try {
        fileStatus.textContent = '正在检查剩余额度…';
        const usedBytes = await readFileUsage();
        if (owner !== account) return;
        showQuota(usedBytes);
        if (file.size > totalBytes - usedBytes) {
          fileStatus.textContent = '剩余额度不足，请先删除不需要的文件。';
          return;
        }
        fileStatus.textContent = '正在上传文件…';
        await uploadFile(file, owner);
        if (owner !== account) return;
        fileInput.value = '';
        const refreshed = await refreshFiles();
        if (owner === account) {
          fileStatus.textContent = refreshed ? '已上传到云端' : '已上传，请刷新记录查看文件和额度。';
        }
      } finally {
        fileInput.disabled = false;
      }
    }, fileStatus, '上传未完成。请先刷新记录，再试着重新上传。');
  });

  async function perform(button, task, feedback, failure) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    input.readOnly = true;
    feedback.textContent = '';
    try {
      await task();
    } catch {
      feedback.textContent = failure;
    } finally {
      input.readOnly = false;
      button.disabled = false;
      busy = false;
    }
  }

  login.addEventListener('submit', event => {
    event.preventDefault();
    void perform(event.submitter, async () => {
      const email = element('email').value.trim();
      const { data, error } = await client.auth.signInWithPassword({ email, password: element('password').value });
      if (error) throw error;
      login.reset();
      showAccount(data.user);
      await loadRecords();
    }, notice, '登录失败，请检查邮箱、密码和网络。');
  });

  async function loadRecords() {
    try {
      await refresh();
    } catch {
      status.textContent = '无法读取云端记录，请点击「刷新记录」重试。';
    }
  }

  element('refresh').addEventListener('click', event => {
    void perform(event.currentTarget, async () => {
      await refresh();
      status.textContent = '已刷新记录';
    }, status, '刷新失败，请检查网络后重试。');
  });

  element('logout').addEventListener('click', event => {
    if (busy) return;
    if ((newDraft || input.value !== (editing?.text ?? '')) &&
        !window.confirm('退出会丢弃当前未保存的内容。继续退出？')) return;
    void perform(event.currentTarget, async () => {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      showAccount(null);
    }, status, '退出失败，请重试。');
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value;
    if (!account || busy) return;
    if (!text.trim()) {
      status.textContent = '请输入内容。';
      input.focus();
      return;
    }
    void perform(event.submitter, async () => {
      const owner = account;
      const request = editing
        ? records().update({ text }).eq('id', editing.id).eq('updated_at', editing.updated_at)
        : records().insert({ text });
      const { data, error } = await request.select(fields).maybeSingle();
      if (owner !== account) return;
      if (error) throw error;
      if (!data) {
        status.textContent = '这条记录已在其他设备更新或删除。请先复制当前编辑内容，再刷新记录。';
        return;
      }
      entries = editing ? entries.map(entry => entry.id === data.id ? data : entry) : [data, ...entries];
      render();
      finishEditing();
      input.focus();
      status.textContent = '已保存到云端';
    }, status, '未能确认保存结果。请先刷新记录，再决定是否重试。');
  });

  cancel.addEventListener('click', () => {
    if (busy) return;
    finishEditing();
    input.focus();
    status.textContent = '';
  });

  function saveDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  list.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !account || busy) return;
    const { id, kind } = button.closest('.transfer-entry').dataset;
    const entry = (kind === 'file' ? files : entries).find(item => item.id === id);
    if (!entry) return;

    if (kind === 'file') {
      if (button.dataset.action === 'download') {
        await perform(button, async () => {
          const owner = account;
          const { data, error } = await storage.download(entry.path);
          if (error) throw error;
          if (owner !== account) return;
          saveDownload(data, entry.filename);
          fileStatus.textContent = '已发起下载';
        }, fileStatus, '下载失败，请刷新记录后重试。');
      } else if (button.dataset.action === 'delete' && window.confirm('删除这个文件？')) {
        await perform(button, async () => {
          const owner = account;
          const { error } = await storage.remove([entry.path]);
          if (error) throw error;
          if (owner !== account) return;
          files = files.filter(item => item.id !== entry.id);
          render();
          const refreshed = await refreshFiles();
          if (owner === account) {
            fileStatus.textContent = refreshed ? '已从云端删除文件' : '已删除，请刷新记录查看剩余额度。';
          }
        }, fileStatus, '删除文件失败，请刷新记录后重试。');
      }
      return;
    }

    switch (button.dataset.action) {
      case 'edit':
        if (editing?.id === entry.id && editing.updated_at === entry.updated_at) {
          input.focus();
          break;
        }
        if (editing && input.value !== editing.text && !window.confirm('放弃当前未保存的修改？')) break;
        if (!editing) newDraft = input.value;
        editing = entry;
        input.value = entry.text;
        label.textContent = '编辑记录';
        cancel.hidden = false;
        status.textContent = '';
        input.focus();
        break;
      case 'copy':
        try {
          await navigator.clipboard.writeText(entry.text);
          button.textContent = '已复制';
          status.textContent = '已复制到剪贴板';
          setTimeout(() => { button.textContent = '复制'; }, 1200);
        } catch {
          status.textContent = '无法访问剪贴板，可以手动选中文字复制。';
        }
        break;
      case 'delete':
        if (!window.confirm('删除这条记录？')) break;
        await perform(button, async () => {
          const owner = account;
          const { data, error } = await records().delete().eq('id', entry.id)
            .eq('updated_at', entry.updated_at).select('id').maybeSingle();
          if (owner !== account) return;
          if (error) throw error;
          if (!data) {
            status.textContent = '记录已在其他设备更新或删除，请刷新记录。';
            return;
          }
          entries = entries.filter(item => item.id !== entry.id);
          if (editing?.id === entry.id) finishEditing();
          render();
          input.focus();
          status.textContent = '已从云端删除';
        }, status, '删除失败，请刷新记录后重试。');
        break;
    }
  });

  client.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') showAccount(null);
  });
  try {
    const { data, error } = await client.auth.getSession();
    showAccount(data.session?.user);
    if (error) notice.textContent = '无法恢复登录，请重新登录。';
    if (account) await perform(element('refresh'), loadRecords, status, '无法读取云端记录。');
  } catch {
    showAccount(null);
    notice.textContent = '无法恢复登录，请重新登录。';
  }
})();
