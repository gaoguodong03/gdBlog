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
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  const fields = 'id,text,updated_at';
  let entries = [];
  let editing = null;
  let newDraft = '';
  let busy = false;
  let account = null;
  let client;

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
  } catch {
    notice.textContent = '随手传连接失败，请刷新页面重试。';
    return;
  }

  const records = () => client.from('transfer_entries');

  function render() {
    element('count').textContent = `${entries.length} 条`;
    element('empty').hidden = entries.length > 0;
    list.replaceChildren();
    for (const entry of entries) {
      const row = template.content.firstElementChild.cloneNode(true);
      row.dataset.id = entry.id;
      row.querySelector('.transfer-entry-content').textContent = entry.text;
      row.querySelector('.transfer-entry-date').textContent = `修改于 ${dateFormat.format(new Date(entry.updated_at))}`;
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
      finishEditing();
      input.value = '';
      status.textContent = '';
      render();
    }
  }

  async function refresh() {
    const owner = account;
    const next = [];
    const pageSize = 250;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await records().select(fields)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (owner !== account) return;
      if (error) throw error;
      next.push(...data);
      if (data.length < pageSize) break;
    }
    entries = next;
    render();
  }

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

  list.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !account || busy) return;
    const entry = entries.find(item => item.id === button.closest('.transfer-entry').dataset.id);
    if (!entry) return;

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
