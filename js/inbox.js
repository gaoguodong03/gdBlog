/* 
 * Browser-only inbox for Hexo + GitHub Pages.
 * Note: Password gate here is only client-side protection.
 */
(function () {
  "use strict";

  const CONFIG = {
    owner: "gaoguodong03",
    repo: "gdBlog",
    branch: "master",
    uploadDir: "inbox",
    maxFileSizeMB: 10,
    // Default password: 717820 (change this hash for your own password).
    passwordSha256: "1075678555d5159043507bc465b01580bd5773c8216aad9a40b2803e43e22d25",
  };

  const STORAGE = {
    token: "gdblog_inbox_token",
  };

  const state = {
    unlocked: false,
    token: "",
  };

  const el = {
    unlockForm: document.getElementById("unlock-form"),
    passwordInput: document.getElementById("password-input"),
    unlockMsg: document.getElementById("unlock-msg"),
    appPanel: document.getElementById("app-panel"),
    tokenInput: document.getElementById("github-token-input"),
    saveTokenBtn: document.getElementById("save-token-btn"),
    clearTokenBtn: document.getElementById("clear-token-btn"),
    tokenMsg: document.getElementById("token-msg"),
    textInput: document.getElementById("text-input"),
    uploadTextBtn: document.getElementById("upload-text-btn"),
    fileInput: document.getElementById("file-input"),
    uploadFileBtn: document.getElementById("upload-file-btn"),
    actionMsg: document.getElementById("action-msg"),
    refreshBtn: document.getElementById("refresh-list-btn"),
    fileList: document.getElementById("file-list"),
  };

  function setMsg(target, text, isError) {
    if (!target) return;
    target.textContent = text || "";
    target.style.color = isError ? "#c0392b" : "#27ae60";
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
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

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
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

  async function fileToBase64(file) {
    const buffer = await file.arrayBuffer();
    return bytesToBase64(new Uint8Array(buffer));
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
    el.fileList.innerHTML = "<li>加载中...</li>";
    try {
      const files = await listInboxFiles();
      if (!files.length) {
        el.fileList.innerHTML = "<li>暂无内容</li>";
        return;
      }
      el.fileList.innerHTML = "";
      files.forEach((file) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = file.name;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "下载";
        btn.className = "inbox-btn";
        btn.addEventListener("click", () => {
          window.open(file.download_url, "_blank", "noopener");
        });
        li.appendChild(name);
        li.appendChild(btn);
        el.fileList.appendChild(li);
      });
    } catch (err) {
      el.fileList.innerHTML = "<li>加载失败，请检查 Token 或仓库权限</li>";
      setMsg(el.actionMsg, err.message || "加载列表失败", true);
    }
  }

  async function handleUnlock(evt) {
    evt.preventDefault();
    const password = (el.passwordInput && el.passwordInput.value) || "";
    if (!password) {
      setMsg(el.unlockMsg, "请输入密码", true);
      return;
    }
    const hashed = await sha256Hex(password);
    if (hashed !== CONFIG.passwordSha256) {
      setMsg(el.unlockMsg, "密码错误", true);
      return;
    }
    state.unlocked = true;
    if (el.appPanel) el.appPanel.style.display = "block";
    if (el.unlockForm) el.unlockForm.style.display = "none";
    setMsg(el.unlockMsg, "");
    await renderFileList();
  }

  async function handleUploadText() {
    if (!state.unlocked) return;
    const text = (el.textInput && el.textInput.value) || "";
    if (!text.trim()) {
      setMsg(el.actionMsg, "请输入要上传的文字", true);
      return;
    }
    try {
      setMsg(el.actionMsg, "上传中...");
      const filename = `${nowStamp()}-text.txt`;
      await uploadBase64File(filename, utf8ToBase64(text), "inbox text");
      if (el.textInput) el.textInput.value = "";
      setMsg(el.actionMsg, "文字上传成功");
      await renderFileList();
    } catch (err) {
      setMsg(el.actionMsg, err.message || "文字上传失败", true);
    }
  }

  async function handleUploadFile() {
    if (!state.unlocked) return;
    const file = el.fileInput && el.fileInput.files && el.fileInput.files[0];
    if (!file) {
      setMsg(el.actionMsg, "请先选择文件", true);
      return;
    }
    if (file.size > CONFIG.maxFileSizeMB * 1024 * 1024) {
      setMsg(el.actionMsg, `文件超过 ${CONFIG.maxFileSizeMB}MB 限制`, true);
      return;
    }
    try {
      setMsg(el.actionMsg, "上传中...");
      const base64 = await fileToBase64(file);
      const filename = `${nowStamp()}-${sanitizeFilename(file.name)}`;
      await uploadBase64File(filename, base64, "inbox file");
      if (el.fileInput) el.fileInput.value = "";
      setMsg(el.actionMsg, "文件上传成功");
      await renderFileList();
    } catch (err) {
      setMsg(el.actionMsg, err.message || "文件上传失败", true);
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
  }

  function bindEvents() {
    if (el.unlockForm) el.unlockForm.addEventListener("submit", handleUnlock);
    if (el.uploadTextBtn) el.uploadTextBtn.addEventListener("click", handleUploadText);
    if (el.uploadFileBtn) el.uploadFileBtn.addEventListener("click", handleUploadFile);
    if (el.refreshBtn) el.refreshBtn.addEventListener("click", renderFileList);
    if (el.saveTokenBtn) el.saveTokenBtn.addEventListener("click", handleSaveToken);
    if (el.clearTokenBtn) el.clearTokenBtn.addEventListener("click", handleClearToken);
  }

  function init() {
    state.token = localStorage.getItem(STORAGE.token) || "";
    bindEvents();
  }

  init();
})();
