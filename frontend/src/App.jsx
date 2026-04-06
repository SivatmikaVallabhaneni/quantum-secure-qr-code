import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";
import {
  Activity,
  ArrowRight,
  Atom,
  Copy,
  Cpu,
  Download,
  Eye,
  FileText,
  Image as ImageIcon,
  Info,
  KeyRound,
  ListFilter,
  Lock,
  Play,
  QrCode,
  Radio,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  Upload,
  Unlock,
  User,
  Zap,
} from "lucide-react";

// -----------------------------------------------------------------------------
// Backend integration — set VITE_API_URL in .env (e.g. http://127.0.0.1:5000)
// Planned / documented endpoints:
//   GET  /quantum-key     — fetch server-side quantum key metadata
//   POST /generate-qr     — generate encrypted payload + QR (placeholder name)
//   POST /verify-qr       — verify scanned QR payload
// Existing Flask demo route (optional):
//   POST /generate-secure-qr — { text } → quantum_key, encrypted_data, qr_payload
// -----------------------------------------------------------------------------
const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "";

const COLORS = {
  bg: "#0B1020",
  card: "#111827",
  blue: "#3B82F6",
  cyan: "#06B6D4",
  purple: "#8B5CF6",
  green: "#10B981",
};

/** Must match backend/app.py MAX_PLAINTEXT_CHARS (plaintext = base64 image string before AES). */
const MAX_IMAGE_B64_CHARS = 1800;
/** Max raw file size before client-side encoding (1 MB). */
const MAX_IMAGE_FILE_BYTES = 1024 * 1024;

function isLikelyImageFile(file) {
  if (!file) return false;
  const name = file.name || "";
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return true;
  const t = file.type || "";
  return t.startsWith("image/") || t === "" || t === "application/octet-stream";
}

const SECURITY_LEVELS = [
  { id: "standard", label: "Standard" },
  { id: "high", label: "High" },
  { id: "maximum", label: "Maximum" },
];

const NAV_LINKS = [
  { id: "section-e91", label: "Key transfer", view: "encrypt" },
  { id: "footer", label: "About", view: null },
];

/** Ekert (1991) QKD — conceptual steps for UI / report (not live entanglement in this demo). */
const E91_FLOW = [
  {
    step: "1",
    title: "Entangled pairs",
    text: "A source distributes entangled qubit pairs (e.g. Bell states) to Alice and Bob over quantum channels.",
    icon: Atom,
  },
  {
    step: "2",
    title: "Bell measurements",
    text: "Each side measures in random bases; outcomes are correlated by quantum mechanics (CHSH / Bell tests detect eavesdropping).",
    icon: Activity,
  },
  {
    step: "3",
    title: "Public discussion",
    text: "Bases and sample results are compared over an authenticated classical channel (not the secret key bits).",
    icon: Radio,
  },
  {
    step: "4",
    title: "Sifting",
    text: "Only rounds where bases matched contribute raw key bits; others are discarded.",
    icon: ListFilter,
  },
  {
    step: "5",
    title: "Privacy amplification",
    text: "Error correction and hashing shrink the sifted string into a final shared secret of high entropy.",
    icon: ShieldCheck,
  },
  {
    step: "6",
    title: "Use with SecureQR",
    text: "In a full deployment that shared key would feed AES (here you simulate with a quantum-random key + QR ciphertext).",
    icon: KeyRound,
  },
];

/** Simulated measurement rounds for E91 demo (educational, not optical QKD). */
function generateE91Rounds(count = 8) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const aliceBase = Math.random() < 0.5 ? "Z" : "X";
    const bobBase = Math.random() < 0.5 ? "Z" : "X";
    const entangledBit = Math.random() < 0.5 ? 0 : 1;
    const sameBasis = aliceBase === bobBase;
    const aliceBit = sameBasis ? entangledBit : Math.random() < 0.5 ? 0 : 1;
    const bobBit = sameBasis ? entangledBit : Math.random() < 0.5 ? 0 : 1;
    rows.push({
      round: i + 1,
      aliceBase,
      bobBase,
      aliceBit,
      bobBit,
      sameBasis,
      contributes: sameBasis,
      keyBit: sameBasis ? entangledBit : "—",
    });
  }
  return rows;
}

const E91_DEMO_PHASES = [
  { id: "entangle", label: "Entangle", hint: "Bell pairs to Alice & Bob" },
  { id: "measure", label: "Measure", hint: "Random Z / X bases" },
  { id: "sifting", label: "Sift", hint: "Keep matching bases" },
  { id: "bell", label: "Bell test", hint: "CHSH-style check (simulated)" },
  { id: "key", label: "Key", hint: "Sifted bit string" },
];

function randomBinaryKey(bits) {
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bits; i++) {
    bin += ((bytes[i >> 3] >> (7 - (i & 7))) & 1).toString();
  }
  return bin.slice(0, bits);
}

function makeSessionId() {
  return `QSID-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Load pixels from file — createImageBitmap first, then HTMLImageElement fallback (wider format support). */
async function loadImageForCanvas(file) {
  try {
    const bmp = await createImageBitmap(file);
    return {
      width: bmp.width,
      height: bmp.height,
      draw: (ctx, cw, ch) => ctx.drawImage(bmp, 0, 0, cw, ch),
      dispose: () => bmp.close?.(),
    };
  } catch {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
          draw: (ctx, cw, ch) => ctx.drawImage(img, 0, 0, cw, ch),
          dispose: () => URL.revokeObjectURL(url),
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read this image (unsupported or corrupt)."));
      };
      img.src = url;
    });
  }
}

/**
 * High-quality JPEG encoding for QR payload: try high quality first, then reduce scale only as needed.
 * Output base64 length must be <= MAX_IMAGE_B64_CHARS (single-QR limit after encryption).
 */
async function compressImageToJpegBase64(file) {
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error("Image must be 1 MB or smaller.");
  }

  const raster = await loadImageForCanvas(file);
  const qualities = [0.98, 0.95, 0.92, 0.88, 0.82, 0.75, 0.68, 0.6, 0.52, 0.45, 0.38];
  try {
    let scale = 1;
    const minScale = 0.03;

    while (scale >= minScale) {
      const w = Math.max(1, Math.round(raster.width * scale));
      const h = Math.max(1, Math.round(raster.height * scale));

      for (const quality of qualities) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas not available.");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        raster.draw(ctx, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const b64 = dataUrl.split(",")[1];
        if (b64 && b64.length <= MAX_IMAGE_B64_CHARS) {
          return { base64: b64, mime: "image/jpeg", previewUrl: dataUrl };
        }
      }

      scale *= 0.9;
    }

    throw new Error(
      "Could not fit this image in one QR code. Try a smaller or simpler image, or use text mode."
    );
  } finally {
    raster.dispose?.();
  }
}

function fakeEncryptedBase64(payload, keyBinary) {
  const combined = `${payload}|${keyBinary.slice(0, 32)}`;
  try {
    return btoa(unescape(encodeURIComponent(combined)));
  } catch {
    return btoa(combined);
  }
}

function computeSecurityScore(level) {
  if (level === "standard") return 78;
  if (level === "high") return 88;
  return 95;
}

const LOG_TEMPLATES = [
  "> Initializing quantum circuit...",
  "> Applying Hadamard gates...",
  "> Measuring qubits...",
  "> Quantum random key generated.",
  "> Encrypting payload...",
  "> Cipher successfully encoded.",
  "> QR matrix rendered.",
  "> Verification ready.",
];

export default function App() {
  const [payloadMode, setPayloadMode] = useState("text");
  const [payload, setPayload] = useState(
    "Classified briefing — distribute only via SecureQR."
  );
  const [imagePreview, setImagePreview] = useState("");
  const [compressedImageB64, setCompressedImageB64] = useState("");
  const [imageMime, setImageMime] = useState("image/jpeg");
  const [lastImageName, setLastImageName] = useState("photo");
  const [imageError, setImageError] = useState("");
  const [imageProcessing, setImageProcessing] = useState(false);
  const [securityLevel, setSecurityLevel] = useState("high");

  const [keyId, setKeyId] = useState(() => `QKEY-${crypto.randomUUID().slice(0, 8)}`);
  const [bitLength, setBitLength] = useState(256);
  const [quantumKeyBin, setQuantumKeyBin] = useState(() => randomBinaryKey(256));
  const [keyGeneratedAt, setKeyGeneratedAt] = useState(() => new Date().toISOString());

  const [encryptionMode] = useState("AES-256");
  const [randomSource] = useState("Quantum Circuit");
  const [encodingType] = useState("Base64");

  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrId, setQrId] = useState("—");
  const [qrTimestamp, setQrTimestamp] = useState("—");
  const [payloadStatus, setPayloadStatus] = useState("Idle");
  const [scanReadiness, setScanReadiness] = useState("Pending");
  const [integrityStatus, setIntegrityStatus] = useState("Not run");
  /** JSON string of { iv, ciphertext } for copy + display when using Flask */
  const [encryptedDisplay, setEncryptedDisplay] = useState("");
  /** Raw encrypted object from server (optional, for clarity) */
  const [encryptedDataObj, setEncryptedDataObj] = useState(null);
  /** Exact string encoded in the QR — paste this into decrypt (or scan QR) */
  const [qrPayloadString, setQrPayloadString] = useState("");
  /** Quantum key string (Flask: measurement bitstring) — required for decrypt */
  const [quantumKeyStr, setQuantumKeyStr] = useState("");
  const [secretsFromBackend, setSecretsFromBackend] = useState(false);
  const [generationComplete, setGenerationComplete] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedHint, setCopiedHint] = useState(null);

  const [logs, setLogs] = useState(["> Quantum engine standby.", "> Awaiting secure generation request."]);
  const logScrollRef = useRef(null);

  const [previewOpen, setPreviewOpen] = useState(false);

  /** Receiver: decrypt panel (same contract as legacy ScanDecrypt.jsx) */
  const [decryptPayloadInput, setDecryptPayloadInput] = useState("");
  const [decryptKeyInput, setDecryptKeyInput] = useState("");
  const [decryptedMessage, setDecryptedMessage] = useState("");
  const [decryptSessionId, setDecryptSessionId] = useState("");
  const [decryptError, setDecryptError] = useState("");
  const [decryptLoading, setDecryptLoading] = useState(false);
  const [decryptedMediaType, setDecryptedMediaType] = useState("text");
  const [decryptedMime, setDecryptedMime] = useState("");

  const [history, setHistory] = useState([]);

  /** Show encrypt path (generate + E91) or decrypt-only UI. */
  const [appView, setAppView] = useState("encrypt");
  /** After E91 demo, decrypt uses session quantum key without showing the key field. */
  const [decryptKeySource, setDecryptKeySource] = useState("manual");

  /** Interactive E91 protocol demo (simulated; not optical QKD). */
  const [e91Phase, setE91Phase] = useState("idle");
  const [e91Busy, setE91Busy] = useState(false);
  const [e91Rounds, setE91Rounds] = useState([]);
  const [e91KeyString, setE91KeyString] = useState("");
  const [e91Chsh, setE91Chsh] = useState(null);
  const e91RunIdRef = useRef(0);

  const appendLogs = useCallback((lines) => {
    setLogs((prev) => [...prev, ...lines]);
  }, []);

  const resetE91Demo = useCallback(() => {
    e91RunIdRef.current += 1;
    setE91Phase("idle");
    setE91Rounds([]);
    setE91KeyString("");
    setE91Chsh(null);
    setE91Busy(false);
    setQuantumKeyStr("");
    setQuantumKeyBin("");
    setBitLength(256);
  }, []);

  const runE91Demo = useCallback(async () => {
    const runId = ++e91RunIdRef.current;
    setE91Busy(true);
    setE91KeyString("");
    setE91Chsh(null);
    const rounds = generateE91Rounds(8);
    setE91Rounds(rounds);

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const advance = async (phase, ms) => {
      setE91Phase(phase);
      await wait(ms);
      return e91RunIdRef.current === runId;
    };

    if (!(await advance("entangle", 1000))) return;
    if (!(await advance("measure", 1000))) return;
    if (!(await advance("sifting", 1200))) return;
    const chsh = 2.05 + Math.random() * 0.65;
    setE91Chsh(Number(chsh.toFixed(3)));
    if (!(await advance("bell", 1100))) return;
    const bits = rounds.filter((row) => row.contributes).map((row) => String(row.keyBit));
    const bitsStr = bits.join("");
    setE91KeyString(bitsStr);
    if (!(await advance("key", 900))) return;
    if (!bitsStr) {
      setE91Phase("idle");
      setE91Busy(false);
      appendLogs(["> No sifted bits this run — click Reset and run the demo again."]);
      return;
    }
    setE91Phase("done");
    setE91Busy(false);
    setQuantumKeyStr(bitsStr);
    setQuantumKeyBin(bitsStr);
    setBitLength(bitsStr.length);
    setKeyId(`E91-${crypto.randomUUID().slice(0, 8)}`);
    setKeyGeneratedAt(new Date().toISOString());
    appendLogs([
      "> E91 key material ready. This exact string is hashed (SHA-256) for AES-256 — generate your QR below, then decrypt with the same key.",
    ]);
  }, [appendLogs]);

  const securityScore = useMemo(() => computeSecurityScore(securityLevel), [securityLevel]);

  const e91DemoStepIndex = useMemo(() => {
    if (e91Phase === "idle") return -1;
    if (e91Phase === "done") return E91_DEMO_PHASES.length;
    return E91_DEMO_PHASES.findIndex((x) => x.id === e91Phase);
  }, [e91Phase]);

  /** Sifted bits from E91 — same string is sent to Flask as quantum_key for AES (SHA-256 of this string). */
  const e91KeyReady = useMemo(
    () => e91Phase === "done" && typeof e91KeyString === "string" && e91KeyString.length > 0,
    [e91Phase, e91KeyString]
  );

  const payloadSize = useMemo(() => {
    if (payloadMode === "image" && compressedImageB64) {
      return Math.floor((compressedImageB64.length * 3) / 4);
    }
    return new Blob([payload]).size;
  }, [payload, payloadMode, compressedImageB64]);

  const scrollToId = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "auto", block: "start" });
  };

  const goToDecryptView = useCallback(() => {
    setAppView("decrypt");
    setTimeout(() => scrollToId("section-decrypt"), 0);
  }, []);

  const goToEncryptView = useCallback(() => {
    setAppView("encrypt");
    setTimeout(() => scrollToId("section-generate"), 0);
  }, []);

  // Scroll only inside the log panel — never scrollIntoView on inner nodes (that moves the whole page)
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const regenerateKey = () => {
    if (secretsFromBackend) {
      appendLogs(["> Server-side key is fixed per generation — click Generate again for a new key."]);
      return;
    }
    const bits = bitLength;
    const next = randomBinaryKey(bits);
    setQuantumKeyBin(next);
    setQuantumKeyStr(next);
    setDecryptKeySource("manual");
    setKeyId(`QKEY-${crypto.randomUUID().slice(0, 8)}`);
    setKeyGeneratedAt(new Date().toISOString());
    appendLogs(["> Local keypool rotated — new demo material committed."]);
  };

  const flashCopied = (id) => {
    setCopiedHint(id);
    setTimeout(() => setCopiedHint(null), 2000);
  };

  const runLogSequence = async () => {
    for (const line of LOG_TEMPLATES) {
      await new Promise((r) => setTimeout(r, 180));
      appendLogs([line]);
    }
  };

  /**
   * POST /generate-secure-qr — { text } → quantum_key, encrypted_data { iv, ciphertext }, qr_payload
   * QR encodes JSON.stringify(qr_payload) so a scanner yields the exact payload for /decrypt-secure-qr.
   */
  const onPickEncryptImage = async (e) => {
    const input = e.target;
    const f = input.files?.[0];
    setImageError("");
    if (!f) return;
    if (f.size > MAX_IMAGE_FILE_BYTES) {
      setImageError(`File is too large (${(f.size / 1024 / 1024).toFixed(2)} MB). Maximum upload size is 1 MB.`);
      input.value = "";
      return;
    }
    if (!isLikelyImageFile(f)) {
      setImageError("Please choose an image file (PNG, JPEG, GIF, WebP, etc.).");
      input.value = "";
      return;
    }
    setImageProcessing(true);
    setCompressedImageB64("");
    setImagePreview("");
    try {
      const { base64, mime, previewUrl } = await compressImageToJpegBase64(f);
      setCompressedImageB64(base64);
      setImageMime(mime);
      setImagePreview(previewUrl);
      setLastImageName(f.name.replace(/\.[^.]+$/, "") || "photo");
      appendLogs([`> Image ready (${base64.length} chars base64, under QR limit).`]);
    } catch (err) {
      const msg = err?.message || "Could not process image.";
      setImageError(msg);
      appendLogs([`> ${msg}`]);
    } finally {
      setImageProcessing(false);
      input.value = "";
    }
  };

  const generateSecureQR = async () => {
    if (payloadMode === "text" && !payload.trim()) {
      appendLogs(["> Error: enter text or switch to image mode."]);
      return;
    }
    if (payloadMode === "image" && !compressedImageB64) {
      appendLogs(["> Choose an image and wait until you see preview / “Ready”, or read the error above."]);
      return;
    }
    if (payloadMode === "image" && imageProcessing) {
      appendLogs(["> Still processing image — wait a moment."]);
      return;
    }
    setIsGenerating(true);
    try {
    setGenerationComplete(false);
    setSecretsFromBackend(false);
    setPayloadStatus("Processing");
    setScanReadiness("Staging");
    setIntegrityStatus("Running");
    setEncryptedDataObj(null);
    setQrPayloadString("");
    appendLogs([
      e91KeyReady && e91KeyString
        ? "> Secure generation started (AES-256-CBC; key material from E91 demo)..."
        : "> Secure generation started (AES-256-CBC; server quantum random key)...",
    ]);

    const sid = makeSessionId();
    const ts = new Date().toISOString();

    try {
      if (API_BASE) {
        const baseBody =
          payloadMode === "image"
            ? { image_base64: compressedImageB64, mime_type: imageMime }
            : { text: payload };
        const body =
          e91KeyReady && e91KeyString ? { ...baseBody, quantum_key: e91KeyString } : baseBody;
        const res = await axios.post(`${API_BASE}/generate-secure-qr`, body);
        const data = res.data;
        const qk = data.quantum_key ?? "";
        const enc = data.encrypted_data;
        const qrPayload = data.qr_payload;

        const payloadStr = qrPayload != null ? JSON.stringify(qrPayload) : "";

        setQuantumKeyStr(qk);
        setQuantumKeyBin(typeof qk === "string" && qk.length ? qk : randomBinaryKey(256));
        setBitLength(typeof qk === "string" ? qk.length : 256);
        setKeyId(data.session_id || sid);
        setKeyGeneratedAt(ts);
        setEncryptedDataObj(enc && typeof enc === "object" ? enc : null);
        setEncryptedDisplay(enc && typeof enc === "object" ? JSON.stringify(enc, null, 2) : "");
        setQrPayloadString(payloadStr);
        setSecretsFromBackend(true);
        setDecryptKeySource("transmission");
        setDecryptKeyInput(qk);

        let url;
        try {
          url = await QRCode.toDataURL(payloadStr, {
            width: 240,
            margin: 2,
            color: { dark: "#3B82F6", light: "#111827" },
            errorCorrectionLevel: "L",
          });
        } catch {
          appendLogs(["> QR matrix too large — reduce image size or text length."]);
          setPayloadStatus("Error");
          return;
        }
        setQrDataUrl(url);
        setQrId(data.session_id || sid);
        setQrTimestamp(ts);
        setPayloadStatus("Encrypted & embedded");
        setScanReadiness("Ready to scan");
        setIntegrityStatus("OK");
        setGenerationComplete(true);

        setHistory((h) => [
          {
            id: data.session_id || sid,
            type: payloadMode === "image" ? "Image" : "Text",
            time: new Date().toLocaleTimeString(),
            status: "Sealed",
          },
          ...h.slice(0, 7),
        ]);

        await runLogSequence();
        return;
      }
    } catch (e) {
      if (e?.response?.status === 400) {
        const d = e.response?.data;
        const msg = d?.error || d?.hint || "Request rejected by server";
        appendLogs([`> ${typeof msg === "string" ? msg : "Bad request"}`]);
        setPayloadStatus("Error");
        return;
      }
      console.warn("Backend unavailable or error — using local simulation.", e);
      appendLogs(["> API unreachable — falling back to local demo (decrypt needs Flask)."]);
    }

    // Local demo — QR is not compatible with server decrypt
    setSecretsFromBackend(false);
    const bits = securityLevel === "maximum" ? 256 : 128;
    const bin =
      e91KeyReady && e91KeyString ? e91KeyString : randomBinaryKey(bits);
    setBitLength(bin.length);
    setQuantumKeyBin(bin);
    setQuantumKeyStr(bin);
    setKeyId(`QKEY-${crypto.randomUUID().slice(0, 8)}`);
    setKeyGeneratedAt(ts);

    const demoPlain = payloadMode === "image" ? compressedImageB64 || "demo" : payload;
    const encStr = fakeEncryptedBase64(demoPlain, bin || "0");
    setEncryptedDisplay(encStr);
    setEncryptedDataObj(null);

    const qrPayload = {
      session_id: sid,
      mode: encryptionMode,
      security_level: securityLevel,
      demo: true,
      media_type: payloadMode === "image" ? "image" : "text",
      encrypted_preview: encStr.slice(0, 48) + "…",
    };
    const payloadStr = JSON.stringify(qrPayload);
    setQrPayloadString(payloadStr);

    try {
      const url = await QRCode.toDataURL(payloadStr, {
        width: 240,
        margin: 2,
        color: { dark: "#3B82F6", light: "#111827" },
        errorCorrectionLevel: "L",
      });
      setQrDataUrl(url);
    } catch (e) {
      console.error(e);
      appendLogs(["> QR render error — payload too large."]);
      return;
    }

    setQrId(sid);
    setQrTimestamp(ts);
    setPayloadStatus("Encrypted & embedded (demo)");
    setScanReadiness("Ready to scan");
    setIntegrityStatus("OK");
    setGenerationComplete(true);
    setDecryptKeySource("transmission");
    setDecryptKeyInput(bin);

    setHistory((h) => [
      {
        id: sid,
        type: payloadMode === "image" ? "Image" : "Text",
        time: new Date().toLocaleTimeString(),
        status: "Demo",
      },
      ...h.slice(0, 7),
    ]);

    await runLogSequence();
    } catch (err) {
      console.error(err);
      appendLogs([`> ${err?.message || "Generation failed unexpectedly."}`]);
      setPayloadStatus("Error");
    } finally {
      setIsGenerating(false);
    }
  };

  const copyText = async (text, successMsg, copyId = null) => {
    try {
      await navigator.clipboard.writeText(text);
      if (copyId) flashCopied(copyId);
      appendLogs([`> Copied to clipboard (${successMsg}).`]);
    } catch {
      appendLogs(["> Clipboard access denied."]);
    }
  };

  const downloadQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    a.download = `secure-qr-${qrId.replace(/[^a-zA-Z0-9]/g, "")}.png`;
    a.click();
    appendLogs(["> QR image exported."]);
  };

  /** POST /decrypt-secure-qr — { qr_payload, quantum_key } */
  const downloadDecryptedImage = () => {
    const b64 = decryptedMessage;
    if (!b64) return;
    const mime = decryptedMime || "image/jpeg";
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
      a.download = `recovered-${(decryptSessionId || "image").replace(/[^a-zA-Z0-9-_]/g, "")}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      appendLogs(["> Decrypted image downloaded."]);
    } catch {
      appendLogs(["> Could not build image file for download."]);
    }
  };

  const runDecrypt = async () => {
    setDecryptError("");
    setDecryptedMessage("");
    setDecryptSessionId("");
    setDecryptedMediaType("text");
    setDecryptedMime("");

    if (!API_BASE) {
      setDecryptError("Set VITE_API_URL in .env and run the Flask backend to decrypt.");
      return;
    }
    const keyMaterial =
      decryptKeySource === "transmission"
        ? (quantumKeyStr || quantumKeyBin || "").trim()
        : decryptKeyInput.trim();
    if (!decryptPayloadInput.trim() || !keyMaterial) {
      setDecryptError(
        decryptKeySource === "transmission"
          ? "Session key missing — generate a QR first, or use “Enter key manually”."
          : "Paste the QR payload JSON and the quantum secret key."
      );
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(decryptPayloadInput);
    } catch {
      setDecryptError("QR payload must be valid JSON (scan the QR or paste from “Copy QR payload”).");
      return;
    }

    const hintMedia = parsed.media_type;
    const hintMime = parsed.mime_type;

    setDecryptLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/decrypt-secure-qr`, {
        qr_payload: parsed,
        quantum_key: keyMaterial,
      });
      setDecryptedMessage(res.data.decrypted_text ?? "");
      setDecryptSessionId(res.data.session_id ?? "");
      const mt = res.data.media_type || hintMedia || "text";
      const mm = res.data.mime_type || hintMime || "";
      setDecryptedMediaType(mt);
      setDecryptedMime(mm);
      appendLogs([
        mt === "image" ? "> Decryption successful — image data recovered." : "> Decryption successful — plaintext recovered.",
      ]);
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        err.response?.data?.details ||
        err.message ||
        "Decryption failed";
      setDecryptError(typeof msg === "string" ? msg : "Decryption failed. Check key and payload.");
      appendLogs(["> Decryption failed — invalid key or corrupted payload."]);
    } finally {
      setDecryptLoading(false);
    }
  };

  const fillDecryptFromLastGeneration = () => {
    if (qrPayloadString) setDecryptPayloadInput(qrPayloadString);
    if (quantumKeyStr) setDecryptKeyInput(quantumKeyStr);
    setDecryptKeySource("manual");
    setAppView("decrypt");
    setTimeout(() => scrollToId("section-decrypt"), 0);
    appendLogs(["> Loaded last generated payload + key into decrypt fields (demo / same device)."]);
  };

  const decodeQrImageFile = async (file) => {
    if (!file) return;
    setDecryptError("");
    try {
      const html5 = new Html5Qrcode("qr-decoder-hidden", { verbose: false });
      const text = await html5.scanFile(file, true);
      setDecryptPayloadInput(text);
      appendLogs(["> QR image decoded — payload JSON placed in decrypt field."]);
    } catch (e) {
      console.error(e);
      setDecryptError("Could not read a QR code from this image. Try a clearer image or paste JSON.");
    }
  };

  const badgeClass = (active) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
      active
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
        : "border-white/10 bg-white/5 text-slate-400"
    }`;

  const cardClass =
    "rounded-2xl border border-white/10 bg-[#111827] p-6 shadow-[0_0_0_1px_rgba(59,130,246,0.06),0_25px_50px_-12px_rgba(0,0,0,0.5)]";

  return (
    <div
      className="min-h-screen text-slate-200"
      style={{
        backgroundColor: COLORS.bg,
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgba(59,130,246,0.12) 1px, transparent 0), radial-gradient(ellipse 80% 50% at 50% -20%, rgba(139,92,246,0.15), transparent)",
        backgroundSize: "28px 28px, 100% 100%",
      }}
    >
      {/* ===================== NAVBAR ===================== */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0B1020]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: "auto" })}
            className="flex items-center gap-3 text-left transition hover:opacity-90"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/30 to-cyan-500/20 shadow-[0_0_20px_rgba(59,130,246,0.35)] ring-1 ring-blue-500/30">
              <Shield className="h-5 w-5 text-cyan-300" />
            </span>
            <span className="text-lg font-semibold tracking-tight text-white">
              SecureQR <span className="text-cyan-400">Quantum</span>
            </span>
          </button>

          <div className="flex flex-1 items-center justify-center gap-2 sm:justify-end">
            <div
              className="flex rounded-xl border border-white/10 bg-black/40 p-0.5"
              role="tablist"
              aria-label="Workflow"
            >
              <button
                type="button"
                role="tab"
                aria-selected={appView === "encrypt"}
                onClick={goToEncryptView}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition sm:px-4 sm:text-sm ${
                  appView === "encrypt"
                    ? "bg-gradient-to-r from-blue-600/90 to-cyan-600/80 text-white shadow-md"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Encrypt
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={appView === "decrypt"}
                onClick={goToDecryptView}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition sm:px-4 sm:text-sm ${
                  appView === "decrypt"
                    ? "bg-gradient-to-r from-emerald-600/90 to-cyan-600/80 text-white shadow-md"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Decrypt
              </button>
            </div>
          </div>

          <nav className="hidden items-center gap-1 lg:flex">
            {NAV_LINKS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  if (l.view) setAppView(l.view);
                  if (l.id === "section-decrypt") setTimeout(() => scrollToId(l.id), 0);
                  else if (l.id === "section-generate" || l.id === "section-e91")
                    setTimeout(() => scrollToId(l.id), 0);
                  else scrollToId(l.id);
                }}
                className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/5 hover:text-white"
              >
                {l.label}
              </button>
            ))}
          </nav>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <span
              className={`hidden rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide sm:inline-flex ${
                API_BASE
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200"
                  : "border-amber-500/35 bg-amber-500/10 text-amber-200"
              }`}
              title="Set VITE_API_URL in .env to connect Flask"
            >
              {API_BASE ? "API linked" : "Demo mode"}
            </span>
          </div>
        </div>
      </header>

      {/* html5-qrcode requires a container element id for file scan */}
      <div id="qr-decoder-hidden" className="fixed left-0 top-0 h-px w-px overflow-hidden opacity-0" aria-hidden />

      <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
        {/* ===================== HERO ===================== */}
        <section id="hero" className="mb-10 text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs text-blue-200">
            <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
            Quantum key · AES-256 · Flask backend
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Quantum Secured QR Code Generator
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-slate-400 sm:text-base">
            E91-style key agreement (simulated) → AES encrypts your payload → QR carries ciphertext → receiver decrypts with
            the same key material.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={goToEncryptView}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-500/20"
            >
              <Zap className="h-4 w-4" />
              Encrypt
            </button>
            <button type="button" onClick={goToDecryptView} className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white">
              <Unlock className="h-4 w-4 text-cyan-400" />
              Decrypt
            </button>
          </div>
        </section>

        {appView === "encrypt" && (
        <>
        {/* ===================== E91 KEY DISTRIBUTION (CONCEPTUAL) ===================== */}
        <section id="section-e91" className="mb-12 scroll-mt-24">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/30 to-cyan-500/20 ring-1 ring-violet-500/40">
                <Atom className="h-6 w-6 text-cyan-300" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-white sm:text-xl">E91 key agreement (Ekert 1991)</h2>
                <p className="mt-1 max-w-2xl text-sm text-slate-400">
                  How a <span className="text-slate-300">shared secret key</span> could reach the receiver in a full
                  quantum network — <span className="text-amber-200/90">conceptual only</span> in this project.
                </p>
              </div>
            </div>
          </div>

          <div className="mb-5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/95">
            <p className="flex gap-2 leading-relaxed">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <span>
                <strong className="font-medium text-white">E91</strong> is for{" "}
                <strong className="font-medium text-white">secure key distribution</strong> only — it does not encrypt the
                message by itself. After a simulated E91 run, the same key string is passed to{" "}
                <strong className="font-medium text-white">AES-256-CBC</strong> (Flask) to encrypt the payload; the QR
                carries ciphertext, not the raw key. This is not optical QKD; it is a <strong className="font-medium text-white">classroom simulation</strong>.
              </span>
            </p>
          </div>

          {/* Interactive E91 simulation */}
          <div className="mb-6 rounded-2xl border border-violet-500/25 bg-gradient-to-b from-violet-950/40 to-[#111827] p-5 shadow-lg ring-1 ring-violet-500/20">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-white">Step 1 · Key transmission (E91, simulated)</h3>
                <p className="mt-1 max-w-xl text-xs text-slate-400">
                  <span className="text-slate-300">Optional:</span> run this to tie encryption to a simulated E91 sifted key
                  (sent to Flask as <span className="text-slate-300">quantum_key</span>). Otherwise you can generate a QR
                  immediately and the server supplies a random quantum key. E91 does not encrypt the message by itself.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={e91Busy}
                  onClick={runE91Demo}
                  className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-violet-500/25 disabled:opacity-50"
                >
                  {e91Busy ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Running…
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      Run demo
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={e91Busy}
                  onClick={resetE91Demo}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-black/30 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>
              </div>
            </div>

            {/* Phase timeline */}
            <div className="mb-5 flex flex-wrap gap-2">
              {E91_DEMO_PHASES.map((p, i) => {
                const current = e91Phase === p.id || (e91Phase === "done" && p.id === "key");
                const completed = e91DemoStepIndex > i;
                return (
                  <div
                    key={p.id}
                    className={`rounded-lg border px-2.5 py-1.5 text-left transition ${
                      current
                        ? "border-cyan-400/60 bg-cyan-500/15 ring-1 ring-cyan-400/40"
                        : completed
                          ? "border-emerald-500/35 bg-emerald-500/10"
                          : "border-white/10 bg-black/20 opacity-60"
                    }`}
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{p.label}</p>
                    <p className="text-[10px] text-slate-500">{p.hint}</p>
                  </div>
                );
              })}
            </div>

            {/* Alice — Source — Bob */}
            <div className="relative mb-6 overflow-hidden rounded-xl border border-white/10 bg-black/35 p-4">
              <div className="flex flex-col items-stretch justify-between gap-6 sm:flex-row sm:items-center sm:justify-between">
                <div
                  className={`flex flex-1 flex-col items-center rounded-xl border p-4 transition ${
                    e91Phase === "measure" || e91Phase === "sifting" || e91Phase === "bell" || e91Phase === "key" || e91Phase === "done"
                      ? "border-cyan-500/40 bg-cyan-500/10"
                      : "border-white/10 bg-black/20"
                  }`}
                >
                  <User className="mb-2 h-8 w-8 text-cyan-300" />
                  <span className="text-xs font-semibold text-white">Alice</span>
                  <span className="mt-1 font-mono text-[10px] text-slate-500">
                    {e91Phase === "idle" ? "—" : e91Phase === "entangle" ? "waiting…" : "bases + bits"}
                  </span>
                </div>

                <div className="relative flex flex-[1.2] flex-col items-center justify-center px-2">
                  <div
                    className={`absolute left-[8%] right-[8%] top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-violet-500/50 to-transparent transition ${
                      e91Phase === "entangle" ? "opacity-100" : "opacity-40"
                    }`}
                  />
                  <div
                    className={`relative z-10 flex flex-col items-center rounded-2xl border px-5 py-4 transition ${
                      e91Phase === "entangle"
                        ? "border-violet-400/50 bg-violet-500/20 shadow-[0_0_24px_rgba(139,92,246,0.35)]"
                        : "border-white/10 bg-black/30"
                    }`}
                  >
                    <Atom className={`mb-1 h-9 w-9 ${e91Phase === "entangle" ? "text-violet-200" : "text-violet-400/80"}`} />
                    <span className="text-xs font-semibold text-white">Source</span>
                    <span className="mt-0.5 text-center text-[10px] text-slate-500">Bell pairs</span>
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-between px-0 sm:px-2">
                    <div
                      className={`h-8 w-px bg-gradient-to-b from-transparent via-cyan-500/40 to-transparent sm:h-12 ${
                        e91Phase === "entangle" ? "animate-pulse" : ""
                      }`}
                    />
                    <div
                      className={`h-8 w-px bg-gradient-to-b from-transparent via-cyan-500/40 to-transparent sm:h-12 ${
                        e91Phase === "entangle" ? "animate-pulse" : ""
                      }`}
                    />
                  </div>
                </div>

                <div
                  className={`flex flex-1 flex-col items-center rounded-xl border p-4 transition ${
                    e91Phase === "measure" || e91Phase === "sifting" || e91Phase === "bell" || e91Phase === "key" || e91Phase === "done"
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : "border-white/10 bg-black/20"
                  }`}
                >
                  <User className="mb-2 h-8 w-8 text-emerald-300" />
                  <span className="text-xs font-semibold text-white">Bob</span>
                  <span className="mt-1 font-mono text-[10px] text-slate-500">
                    {e91Phase === "idle" ? "—" : e91Phase === "entangle" ? "waiting…" : "bases + bits"}
                  </span>
                </div>
              </div>
            </div>

            {/* Sifting table */}
            {e91Rounds.length > 0 && (
              <div className="mb-4 overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[520px] border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/10 bg-black/40 text-[10px] uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2 font-medium">Round</th>
                      <th className="px-3 py-2 font-medium">Alice base</th>
                      <th className="px-3 py-2 font-medium">Bob base</th>
                      <th className="px-3 py-2 font-medium">Alice bit</th>
                      <th className="px-3 py-2 font-medium">Bob bit</th>
                      <th className="px-3 py-2 font-medium">Key bit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e91Rounds.map((row) => {
                      const highlight =
                        (e91Phase === "sifting" || e91Phase === "bell" || e91Phase === "key" || e91Phase === "done") &&
                        row.contributes;
                      return (
                        <tr
                          key={row.round}
                          className={`border-b border-white/5 transition ${
                            highlight ? "bg-emerald-500/15" : e91Phase === "measure" ? "bg-white/[0.03]" : ""
                          }`}
                        >
                          <td className="px-3 py-2 font-mono text-slate-400">{row.round}</td>
                          <td className="px-3 py-2 font-mono text-cyan-200/90">{row.aliceBase}</td>
                          <td className="px-3 py-2 font-mono text-emerald-200/90">{row.bobBase}</td>
                          <td className="px-3 py-2 font-mono text-slate-300">{row.aliceBit}</td>
                          <td className="px-3 py-2 font-mono text-slate-300">{row.bobBit}</td>
                          <td className="px-3 py-2 font-mono text-amber-200/95">{row.keyBit}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Bell + key readout */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className={`rounded-xl border px-4 py-3 transition ${
                  e91Phase === "bell" || e91Phase === "key" || e91Phase === "done"
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-white/10 bg-black/25 opacity-60"
                }`}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Simulated CHSH / Bell</p>
                <p className="mt-1 font-mono text-lg text-amber-100">{e91Chsh != null ? e91Chsh.toFixed(3) : "—"}</p>
                <p className="mt-1 text-[10px] text-slate-500">
                  Real devices target ~2√2 ≈ 2.828 under ideal conditions; values near 2 suggest classical limits.
                </p>
              </div>
              <div
                className={`rounded-xl border px-4 py-3 transition ${
                  e91Phase === "key" || e91Phase === "done" ? "border-cyan-500/40 bg-cyan-500/10" : "border-white/10 bg-black/25 opacity-60"
                }`}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Sifted key (bits)</p>
                <p className="mt-1 break-all font-mono text-sm leading-relaxed text-cyan-100">
                  {e91Phase === "done" && !e91KeyString
                    ? "No rounds shared a basis — run again."
                    : e91KeyString || (e91Phase === "idle" ? "Run the demo to generate rounds." : "…")}
                </p>
                {e91KeyString && (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(e91KeyString).catch(() => {});
                    }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/30 px-2.5 py-1 text-[10px] font-medium text-slate-300 hover:bg-white/5"
                  >
                    <Copy className="h-3 w-3" />
                    Copy key bits
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="mb-6 rounded-2xl border border-white/10 bg-[#111827] p-5 shadow-lg ring-1 ring-violet-500/10">
            <p className="mb-4 text-center text-xs font-medium uppercase tracking-wider text-slate-500">
              Conceptual path: quantum correlation → classical coordination → shared key
            </p>
            <div className="hidden gap-2 md:flex md:flex-wrap md:items-stretch md:justify-center">
              {E91_FLOW.map((item, i) => {
                const Icon = item.icon;
                return (
                  <div key={item.step} className="flex items-stretch">
                    <div className="flex w-[140px] flex-col rounded-xl border border-white/10 bg-black/30 p-3 text-center sm:w-[150px]">
                      <span className="mb-2 font-mono text-[10px] text-violet-400">Step {item.step}</span>
                      <Icon className="mx-auto mb-2 h-6 w-6 text-cyan-400" />
                      <h3 className="text-xs font-semibold text-white">{item.title}</h3>
                      <p className="mt-1.5 text-left text-[10px] leading-snug text-slate-500">{item.text}</p>
                    </div>
                    {i < E91_FLOW.length - 1 && (
                      <div className="flex items-center px-0.5 text-slate-600">
                        <ArrowRight className="h-4 w-4 shrink-0" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-col gap-3 md:hidden">
              {E91_FLOW.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.step}
                    className="flex gap-3 rounded-xl border border-white/10 bg-black/30 p-4"
                  >
                    <span className="font-mono text-xs text-violet-400">{item.step}</span>
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-cyan-400" />
                    <div>
                      <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-slate-500">{item.text}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-sm text-slate-300">
              <p className="mb-1 font-medium text-cyan-200">How this relates to your demo</p>
              <ul className="list-inside list-disc space-y-1 text-xs text-slate-400">
                <li>
                  <span className="text-slate-300">QR code</span> carries ciphertext (and metadata), not the raw quantum
                  key.
                </li>
                <li>
                  <span className="text-slate-300">Flow here</span>: E91 (simulated) establishes key material → AES encrypts
                  the payload → QR holds ciphertext → Decrypt uses the same key string (transmission or manual).
                </li>
                <li>
                  <span className="text-slate-300">With real E91</span>: the key would be established between endpoints
                  first; AES would use that material instead of manual paste.
                </li>
              </ul>
            </div>
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-sm text-slate-300">
              <p className="mb-1 font-medium text-violet-200">Future work (report bullets)</p>
              <ul className="list-inside list-disc space-y-1 text-xs text-slate-400">
                <li>Integrate a QKD API or lab interface for key material.</li>
                <li>Simulate E91 rounds in Qiskit for coursework visuals (still not optical QKD).</li>
                <li>Keep classical AES for payload encryption; QKD only for key establishment.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ===================== MAIN WORKFLOW ===================== */}
        <section className="mb-12">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-blue-400" />
              <h2 className="text-lg font-semibold text-white sm:text-xl">Step 2 · Encrypt payload &amp; export QR</h2>
            </div>
            {API_BASE ? (
              <span className="text-xs text-cyan-300/90">API connected</span>
            ) : (
              <span className="text-xs text-amber-200/90">Set VITE_API_URL for live encrypt/decrypt</span>
            )}
          </div>

          <div id="section-generate" className="grid gap-5 lg:grid-cols-3">
            {/* LEFT — Payload */}
            <div className={`${cardClass} hover:shadow-[0_0_30px_rgba(59,130,246,0.12)]`}>
              <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-white">
                <FileText className="h-5 w-5 text-blue-400" />
                Payload Configuration
              </h3>
              <div className="mb-4 flex gap-1 rounded-xl bg-black/30 p-1 ring-1 ring-white/10">
                <button
                  type="button"
                  onClick={() => {
                    setPayloadMode("text");
                    setImageError("");
                  }}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-medium transition sm:text-sm ${
                    payloadMode === "text"
                      ? "bg-blue-600/90 text-white shadow-lg shadow-blue-500/20"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <FileText className="h-4 w-4" />
                  Text
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPayloadMode("image");
                    setImageError("");
                  }}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-medium transition sm:text-sm ${
                    payloadMode === "image"
                      ? "bg-blue-600/90 text-white shadow-lg shadow-blue-500/20"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <ImageIcon className="h-4 w-4" />
                  Image
                </button>
              </div>
              {payloadMode === "text" ? (
                <textarea
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  rows={5}
                  placeholder="Enter secret text..."
                  className="mb-4 w-full resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-200 outline-none ring-0 placeholder:text-slate-600 focus:border-blue-500/50"
                />
              ) : (
                <div className="mb-4">
                  <p className="mb-2 text-xs leading-relaxed text-slate-500">
                    Max file size <span className="text-slate-300">1 MB</span>. We encode at{" "}
                    <span className="text-slate-300">high JPEG quality</span> first, then scale down only as needed so
                    the payload fits one QR (~{MAX_IMAGE_B64_CHARS} base64 chars after encryption — backend limit).
                  </p>
                  <label
                    htmlFor="encrypt-image-input"
                    className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/20 bg-black/30 py-8 transition hover:border-blue-500/40 ${imageProcessing ? "pointer-events-none opacity-60" : ""}`}
                  >
                    <input
                      id="encrypt-image-input"
                      type="file"
                      accept="image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp"
                      className="sr-only"
                      onChange={onPickEncryptImage}
                      disabled={imageProcessing}
                    />
                    <Upload className="mb-2 h-8 w-8 text-slate-500" />
                    <span className="text-sm text-slate-300">
                      {imageProcessing ? "Processing…" : "Choose image"}
                    </span>
                  </label>
                  {imageError && (
                    <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                      {imageError}
                    </p>
                  )}
                  {imagePreview ? (
                    <img
                      src={imagePreview}
                      alt="Will encrypt"
                      className="mt-3 max-h-44 w-full rounded-lg border border-white/10 object-contain"
                    />
                  ) : (
                    <p className="mt-2 text-center text-xs text-slate-600">No image selected</p>
                  )}
                  {compressedImageB64 && (
                    <p className="mt-2 text-center text-[11px] text-emerald-400/90">
                      Ready · {compressedImageB64.length} chars (base64)
                    </p>
                  )}
                </div>
              )}
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Security Level
              </label>
              <select
                value={securityLevel}
                onChange={(e) => setSecurityLevel(e.target.value)}
                className="mb-4 w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white outline-none focus:border-blue-500/50"
              >
                {SECURITY_LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={isGenerating}
                onClick={generateSecureQR}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-blue-500/30 transition hover:brightness-110 disabled:opacity-60"
              >
                {isGenerating ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Generating…
                  </>
                ) : (
                  <>
                    <QrCode className="h-5 w-5" />
                    Generate Secure QR
                  </>
                )}
              </button>
            </div>

            {/* MIDDLE — Engine */}
            <div className={`${cardClass} hover:shadow-[0_0_30px_rgba(6,182,212,0.12)]`}>
              <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-white">
                <Cpu className="h-5 w-5 text-cyan-400" />
                Quantum Security Engine
              </h3>

              <div className="mb-4 rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-cyan-300/90">
                  Session key (E91 → AES)
                </p>
                <p className="mb-2 text-[10px] leading-snug text-slate-500">
                  After Generate, the active key is shown here. If you ran E91 first, that sifted string is used; otherwise
                  the server generates a quantum key. AES-256-CBC uses SHA-256 of that key string.
                </p>
                <div className="space-y-2 text-xs sm:text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Key ID</span>
                    <span className="font-mono text-cyan-200">{keyId}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Sifted bits</span>
                    <span className="text-white">{bitLength}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Key material (same for encrypt &amp; decrypt)</span>
                    <p className="mt-1 max-h-24 overflow-y-auto break-all font-mono text-[10px] leading-relaxed text-slate-300 sm:text-xs">
                      {(quantumKeyStr || quantumKeyBin).slice(0, 128)}
                      {(quantumKeyStr || quantumKeyBin).length > 128 ? "…" : ""}
                    </p>
                  </div>
                  <div className="flex justify-between gap-2 text-xs">
                    <span className="text-slate-500">Generated At</span>
                    <span className="font-mono text-slate-400">{keyGeneratedAt.slice(0, 19)}Z</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={regenerateKey}
                  disabled={secretsFromBackend || e91KeyReady}
                  title={e91KeyReady ? "Reset the E91 demo to change key material" : undefined}
                  className="mt-3 w-full rounded-lg border border-cyan-500/40 bg-black/30 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {secretsFromBackend
                    ? "Key fixed after Generate (run E91 again if starting fresh)"
                    : e91KeyReady
                      ? "Locked — use E91 Reset to change key"
                      : "Regenerate Key (optional)"}
                </button>
              </div>

              <div className="mb-4 rounded-xl border border-white/10 bg-black/30 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Encryption Details</p>
                <ul className="space-y-1.5 text-sm">
                  <li className="flex justify-between">
                    <span className="text-slate-500">Encryption Mode</span>
                    <span className="text-white">{encryptionMode}</span>
                  </li>
                  <li className="flex justify-between">
                    <span className="text-slate-500">Key source</span>
                    <span className="text-cyan-300">
                      {e91KeyReady ? "E91 (simulated) + Flask AES" : "Server QRNG (or run E91 first)"}
                    </span>
                  </li>
                  <li className="flex justify-between">
                    <span className="text-slate-500">Payload</span>
                    <span className="text-cyan-200">{payloadMode === "image" ? "Image (JPEG)" : "Text"}</span>
                  </li>
                  <li className="flex justify-between">
                    <span className="text-slate-500">Encoding Type</span>
                    <span>{encodingType}</span>
                  </li>
                  <li className="flex justify-between">
                    <span className="text-slate-500">Payload Size</span>
                    <span>{payloadSize} bytes</span>
                  </li>
                  <li className="flex justify-between">
                    <span className="text-slate-500">Security Score</span>
                    <span className="text-emerald-400">{securityScore}%</span>
                  </li>
                </ul>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <span className={badgeClass(generationComplete)}>AES-256</span>
                <span className={badgeClass(generationComplete)}>QR ready</span>
              </div>

              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-slate-400">Security Strength</span>
                  <span className="font-semibold text-blue-300">{securityScore}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-black/50 ring-1 ring-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 via-cyan-400 to-emerald-400 transition-[width] duration-500"
                    style={{ width: `${securityScore}%` }}
                  />
                </div>
              </div>
            </div>

            {/* RIGHT — Output */}
            <div className={`${cardClass} hover:shadow-[0_0_30px_rgba(139,92,246,0.12)]`}>
              <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-white">
                <QrCode className="h-5 w-5 text-purple-400" />
                Secure QR Output
              </h3>
              <div className="flex flex-col items-center rounded-xl border border-white/10 bg-black/40 p-4">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Secure QR" className="h-52 w-52 rounded-lg object-contain sm:h-56 sm:w-56" />
                ) : (
                  <div className="flex h-56 w-56 items-center justify-center rounded-lg border border-dashed border-white/20 bg-black/30 text-sm text-slate-500">
                    Awaiting generation
                  </div>
                )}
              </div>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Session / QR ID</dt>
                  <dd className="text-right font-mono text-xs text-white">{qrId}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Timestamp</dt>
                  <dd className="font-mono text-xs text-slate-300">{qrTimestamp}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Payload Status</dt>
                  <dd className="text-emerald-300">{payloadStatus}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Scan Readiness</dt>
                  <dd className="text-cyan-300">{scanReadiness}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Integrity</dt>
                  <dd className="text-blue-300">{integrityStatus}</dd>
                </div>
              </dl>

              <div className="mt-4 rounded-xl border border-white/10 bg-black/35 p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Sender secrets (share key out-of-band)
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      (quantumKeyStr || quantumKeyBin) &&
                      copyText(quantumKeyStr || quantumKeyBin, "quantum key", "key")
                    }
                    disabled={!(quantumKeyStr || quantumKeyBin)}
                    className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-left text-xs font-semibold text-amber-100 transition hover:bg-amber-500/15 disabled:opacity-40"
                  >
                    <span className="flex items-center gap-2">
                      <KeyRound className="h-3.5 w-3.5 shrink-0" />
                      Copy quantum key
                    </span>
                    {copiedHint === "key" ? <span className="text-emerald-400">Copied</span> : <Copy className="h-3.5 w-3.5 opacity-60" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => encryptedDisplay && copyText(encryptedDisplay, "encrypted JSON", "enc")}
                    disabled={!encryptedDisplay}
                    className="flex items-center justify-between gap-2 rounded-lg border border-cyan-500/25 bg-cyan-500/5 px-3 py-2 text-left text-xs font-semibold text-cyan-100 transition hover:bg-cyan-500/15 disabled:opacity-40"
                  >
                    <span className="flex items-center gap-2">
                      <Lock className="h-3.5 w-3.5 shrink-0" />
                      Copy encrypted data (iv + ciphertext)
                    </span>
                    {copiedHint === "enc" ? <span className="text-emerald-400">Copied</span> : <Copy className="h-3.5 w-3.5 opacity-60" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => qrPayloadString && copyText(qrPayloadString, "QR payload JSON", "qr")}
                    disabled={!qrPayloadString}
                    className="flex items-center justify-between gap-2 rounded-lg border border-purple-500/25 bg-purple-500/5 px-3 py-2 text-left text-xs font-semibold text-purple-100 transition hover:bg-purple-500/15 disabled:opacity-40"
                  >
                    <span className="flex items-center gap-2">
                      <QrCode className="h-3.5 w-3.5 shrink-0" />
                      Copy QR payload (same as QR content)
                    </span>
                    {copiedHint === "qr" ? <span className="text-emerald-400">Copied</span> : <Copy className="h-3.5 w-3.5 opacity-60" />}
                  </button>
                </div>
                {!API_BASE && (
                  <p className="mt-2 text-[11px] leading-snug text-amber-200/80">
                    Demo mode: ciphertext is simulated — only Flask-backed runs decrypt on the server.
                  </p>
                )}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={downloadQr}
                  disabled={!qrDataUrl}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-2.5 text-xs font-semibold text-white transition hover:bg-white/10 disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download QR
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  disabled={!qrDataUrl}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-purple-500/30 bg-purple-500/10 py-2.5 text-xs font-semibold text-purple-200 transition hover:bg-purple-500/20 disabled:opacity-40"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview
                </button>
                <button
                  type="button"
                  onClick={fillDecryptFromLastGeneration}
                  disabled={!qrPayloadString}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 py-2.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-40"
                >
                  <Unlock className="h-3.5 w-3.5" />
                  Open decrypt & load last QR + key
                </button>
              </div>
            </div>
          </div>

          {history.length > 0 && (
            <div className="mt-6 rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-xs text-slate-400">
              <span className="font-medium text-slate-300">Recent: </span>
              {history.slice(0, 4).map((row) => (
                <span key={row.id} className="mr-3 inline font-mono text-[10px] text-slate-500">
                  {row.id} · {row.time}
                </span>
              ))}
            </div>
          )}
        </section>


        </>
        )}

        {/* ===================== DECRYPT (RECEIVER) — POST /decrypt-secure-qr ===================== */}
        {appView === "decrypt" && (
        <section id="section-decrypt" className="mb-12">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-center gap-3">
              <Unlock className="h-7 w-7 text-emerald-400" />
              <div>
                <h2 className="text-2xl font-bold text-white">Decrypt (receiver)</h2>
                <p className="text-sm text-slate-400">
                  {decryptKeySource === "transmission" ? (
                    <>
                      Paste or scan the <span className="text-slate-300">QR payload</span> only — the quantum key came from
                      key transmission. Calls{" "}
                      <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-cyan-200">POST /decrypt-secure-qr</code>
                    </>
                  ) : (
                    <>
                      Paste the JSON from the QR (or scan) and the quantum key — calls{" "}
                      <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-cyan-200">POST /decrypt-secure-qr</code>
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>

          {decryptKeySource === "transmission" && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100/95">
              <p className="flex min-w-0 flex-1 items-start gap-2 leading-relaxed">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                <span>
                  Using the <strong className="font-medium text-white">session quantum key</strong> from encrypt (delivered
                  after key transmission). You do not need to paste the key unless you switch to manual entry below.
                </span>
              </p>
              <button
                type="button"
                onClick={() => {
                  setDecryptKeySource("manual");
                  setDecryptKeyInput((quantumKeyStr || quantumKeyBin || decryptKeyInput).trim());
                }}
                className="shrink-0 rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/10"
              >
                Enter key manually
              </button>
            </div>
          )}

          {!API_BASE && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Add <code className="rounded bg-black/30 px-1">VITE_API_URL=http://127.0.0.1:5000</code> to{" "}
              <code className="rounded bg-black/30 px-1">frontend/.env</code> and run the Flask app so decryption
              matches the server encryption.
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <div className={`${cardClass} flex flex-col`}>
              <p className="mb-3 flex items-center gap-2 font-semibold text-white">
                <Upload className="h-5 w-5 text-blue-400" />
                Load QR from image
              </p>
              <p className="mb-3 text-xs text-slate-500">
                Optional: upload a screenshot of the QR — the decoded text fills the payload field (same string as
                “Copy QR payload”).
              </p>
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) decodeQrImageFile(f);
                }}
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/40 py-10 text-center transition hover:border-blue-500/40 hover:bg-white/5"
              >
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => decodeQrImageFile(e.target.files?.[0])}
                />
                <Upload className="mb-2 h-9 w-9 text-slate-500" />
                <span className="text-sm text-slate-300">Drop image or click to decode QR</span>
              </label>

              <label className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-500">
                QR payload JSON
              </label>
              <textarea
                value={decryptPayloadInput}
                onChange={(e) => setDecryptPayloadInput(e.target.value)}
                rows={6}
                placeholder='{"session_id":"QSID-...","encrypted_data":{"iv":"...","ciphertext":"..."}}'
                className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-black/50 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-blue-500/50"
              />

              {decryptKeySource === "manual" && (
                <>
                  <label className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-500">
                    Quantum secret key
                  </label>
                  <textarea
                    value={decryptKeyInput}
                    onChange={(e) => setDecryptKeyInput(e.target.value)}
                    rows={3}
                    placeholder="Paste the key from the sender (same as Copy quantum key)"
                    className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-black/50 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-blue-500/50"
                  />
                </>
              )}

              {decryptKeySource === "manual" && (quantumKeyStr || quantumKeyBin) && (
                <button
                  type="button"
                  onClick={() => {
                    setDecryptKeyInput((quantumKeyStr || quantumKeyBin || "").trim());
                    setDecryptKeySource("transmission");
                  }}
                  className="mt-3 w-full rounded-lg border border-cyan-500/30 bg-cyan-500/10 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-500/20"
                >
                  Use session key from Encrypt (skip pasting key)
                </button>
              )}

              <button
                type="button"
                disabled={decryptLoading}
                onClick={runDecrypt}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-cyan-600 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/20 disabled:opacity-60"
              >
                {decryptLoading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Decrypting…
                  </>
                ) : (
                  <>
                    <Unlock className="h-4 w-4" />
                    Decrypt with Flask
                  </>
                )}
              </button>
              {decryptError && (
                <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  {decryptError}
                </p>
              )}
            </div>

            <div className={`${cardClass}`}>
              <p className="mb-3 font-semibold text-white">Recovered content</p>
              {decryptedMessage ? (
                <div className="space-y-3">
                  {decryptSessionId && (
                    <div className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs">
                      <span className="text-slate-500">Session</span>
                      <p className="font-mono text-cyan-200">{decryptSessionId}</p>
                    </div>
                  )}
                  {decryptedMediaType === "image" ? (
                    <div className="space-y-3">
                      <div className="overflow-hidden rounded-xl border border-emerald-500/25 bg-black/40 p-2">
                        <img
                          src={`data:${decryptedMime || "image/jpeg"};base64,${decryptedMessage}`}
                          alt="Decrypted"
                          className="mx-auto max-h-64 w-full object-contain"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={downloadDecryptedImage}
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/15 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/25"
                      >
                        <Download className="h-4 w-4" />
                        Download image
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
                      <p className="text-sm leading-relaxed text-slate-100">{decryptedMessage}</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  Text or image appears here after decrypt. Paste or scan the QR payload
                  {decryptKeySource === "manual" ? " and key" : ""}.
                </p>
              )}
            </div>
          </div>
        </section>
        )}

        {/* ===================== LOGS (collapsible) ===================== */}
        <details className="mb-10 group">
          <summary className="mb-3 flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-slate-300 [&::-webkit-details-marker]:hidden">
            <Terminal className="h-5 w-5 text-cyan-500" />
            Engine log
            <span className="text-xs font-normal text-slate-500">(click to expand)</span>
          </summary>
          <div
            className="overflow-hidden rounded-xl border border-white/10 bg-black/50"
            style={{ fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace" }}
          >
            <div
              ref={logScrollRef}
              className="max-h-40 overflow-y-auto p-3 text-xs leading-relaxed text-cyan-100/90"
            >
              {logs.map((line, i) => (
                <div key={`${i}-${line}`} className="whitespace-pre-wrap">
                  {line}
                </div>
              ))}
              <span className="terminal-cursor inline-block" />
            </div>
          </div>
        </details>

        {/* ===================== FOOTER ===================== */}
        <footer id="footer" className="border-t border-white/10 pt-8 pb-4">
          <p className="text-center text-xs text-slate-500">
            SecureQR Quantum · React, Vite, Tailwind · Flask + Qiskit backend
          </p>
        </footer>
      </main>

      {/* Preview modal */}
      {previewOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setPreviewOpen(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-sm rounded-2xl border border-white/10 bg-[#111827] p-6 shadow-2xl"
            role="dialog"
          >
            <h4 className="mb-4 text-lg font-semibold text-white">QR preview</h4>
            {qrDataUrl && <img src={qrDataUrl} alt="Preview" className="mx-auto rounded-lg border border-white/10" />}
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="mt-4 w-full rounded-xl bg-white/10 py-2 text-sm font-semibold text-white"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
