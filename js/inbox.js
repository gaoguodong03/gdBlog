/*
 * Browser-only text message wall for Hexo + GitHub Pages.
 */
(function () {
  "use strict";

  const CONFIG = {
    owner: "gaoguodong03",
    repo: "gdBlog",
    branch: "master",
    uploadDir: "inbox",
  };

  const STORAGE = {
    token: "gdblog_inbox_token",
  };

  const state = {
    token: "",
  };

  const el = {
    tokenInput: document.getElementById("github-token-input"),
    saveTokenBtn: document.getElementById("save-token-btn"),
    clearTokenBtn: document.getElementById("clear-token-btn"),
    tokenMsg: document.getElementById("token-msg"),
    textInput: document.getElementById("text-input"),
    uploadTextBtn: document.getElementById("upload-text-btn"),
    actionMsg: document.getElementById("action-msg"),
    refreshBtn: document.getElementById("refresh-list-btn"),
    fileList: document.getElementById("file-list"),
  };

  function setMsg(target, text, isError) {
    if (!target) return;
    target.textContent = text || "";
    target.style.color = isError ? "#c0392b" : "#27ae60";
  }

  function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "-" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    return bytesToBase64(bytes);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function getToken() {
    return (state.token || "").trim();
  }

  async function githubRequest(path, options) {
    const token = getToken();
    if (!token) throw new Error("请先保存 GitHub Token");
    const resp = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options && options.headers ? options.headers : {}),
      },
    });
    if (!resp.ok) {
      let detail = "";
      try {
        const data = await resp.json();
        detail = data && data.message ? `: ${data.message}` : "";
      } catch (_err) {
        // ignore parse error
      }
      throw new Error(`GitHub API ${resp.status}${detail}`);
    }
    return resp.json();
  }

  async function uploadBase64File(filename, base64Content, messagePrefix) {
    const path = `${CONFIG.uploadDir}/${filename}`;
    return githubRequest(
      `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${encodeURIComponent(path).replace(
        /%2F/g,
        "/"
      )}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `${messagePrefix}: ${filename}`,
          content: base64Content,
          branch: CONFIG.branch,
        }),
      }
    );
  }

  function extractTimeLabel(fileName) {
    const match = fileName.match(/^(\d{8})-(\d{6})/);
    if (!match) return "未知时间";
    const datePart = match[1];
    const timePart = match[2];
    const y = datePart.slice(0, 4);
    const m = datePart.slice(4, 6);
    const d = datePart.slice(6, 8);
    const hh = timePart.slice(0, 2);
    const mm = timePart.slice(2, 4);
    const ss = timePart.slice(4, 6);
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }

  async function listInboxFiles() {
    const token = getToken();
    const headers = {
      Accept: "application/vnd.github+json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const url =
      `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/` +
      `${encodeURIComponent(CONFIG.uploadDir)}?ref=${encodeURIComponent(CONFIG.branch)}`;
    const resp = await fetch(url, { headers });
    if (resp.status === 404) return [];
    if (!resp.ok) {
      let detail = "";
      try {
        const data = await resp.json();
        detail = data && data.message ? `: ${data.message}` : "";
      } catch (_err) {
        // ignore parse error
      }
      throw new Error(`获取列表失败 ${resp.status}${detail}`);
    }
    const items = await resp.json();
    return Array.isArray(items)
      ? items.filter((it) => it.type === "file").sort((a, b) => b.name.localeCompare(a.name))
      : [];
  }

  async function renderFileList() {
    if (!el.fileList) return;
    el.fileList.innerHTML = "<li>加载留言中...</li>";
    try {
      const files = await listInboxFiles();
      if (!files.length) {
        el.fileList.innerHTML = "<li>暂无留言</li>";
        return;
      }
      el.fileList.innerHTML = "";
      files.forEach((file) => {
        const li = document.createElement("li");
        const left = document.createElement("div");
        const time = document.createElement("div");
        time.className = "message-meta";
        time.textContent = extractTimeLabel(file.name);
        const name = document.createElement("div");
        name.textContent = file.name.replace(/^\d{8}-\d{6}-/, "");
        left.appendChild(time);
        left.appendChild(name);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "查看";
        btn.className = "inbox-btn";
        btn.addEventListener("click", () => {
          window.open(file.download_url, "_blank", "noopener");
        });
        li.appendChild(left);
        li.appendChild(btn);
        el.fileList.appendChild(li);
      });
    } catch (err) {
      el.fileList.innerHTML = "<li>加载失败，请检查 Token 或仓库权限</li>";
      setMsg(el.actionMsg, err.message || "加载留言失败", true);
    }
  }

  async function handleUploadText() {
    const text = (el.textInput && el.textInput.value) || "";
    if (!text.trim()) {
      setMsg(el.actionMsg, "请输入留言内容", true);
      return;
    }
    try {
      setMsg(el.actionMsg, "发布中...");
      const filename = `${nowStamp()}-message.txt`;
      await uploadBase64File(filename, utf8ToBase64(text), "inbox message");
      if (el.textInput) el.textInput.value = "";
      setMsg(el.actionMsg, "留言发布成功");
      await renderFileList();
    } catch (err) {
      setMsg(el.actionMsg, err.message || "留言发布失败", true);
    }
  }

  function handleSaveToken() {
    const token = (el.tokenInput && el.tokenInput.value.trim()) || "";
    if (!token) {
      setMsg(el.tokenMsg, "Token 不能为空", true);
      return;
    }
    localStorage.setItem(STORAGE.token, token);
    state.token = token;
    if (el.tokenInput) el.tokenInput.value = "";
    setMsg(el.tokenMsg, "Token 已保存到当前浏览器");
    renderFileList();
  }

  function handleClearToken() {
    localStorage.removeItem(STORAGE.token);
    state.token = "";
    setMsg(el.tokenMsg, "Token 已清除");
    renderFileList();
  }

  function bindEvents() {
    if (el.uploadTextBtn) el.uploadTextBtn.addEventListener("click", handleUploadText);
    if (el.refreshBtn) el.refreshBtn.addEventListener("click", renderFileList);
    if (el.saveTokenBtn) el.saveTokenBtn.addEventListener("click", handleSaveToken);
    if (el.clearTokenBtn) el.clearTokenBtn.addEventListener("click", handleClearToken);
  }

  function init() {
    state.token = localStorage.getItem(STORAGE.token) || "";
    bindEvents();
    renderFileList();
  }

  init();
})();
