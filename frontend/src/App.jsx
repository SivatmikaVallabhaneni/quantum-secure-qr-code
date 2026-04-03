import { useState, useRef } from "react";
import { QRCodeCanvas } from "qrcode.react";
import axios from "axios";
import "./App.css";

function App() {
  const [text, setText] = useState("");
  const [qrValue, setQrValue] = useState("");
  const [key, setKey] = useState("");
  const [encryptedText, setEncryptedText] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [qrPayloadText, setQrPayloadText] = useState("");

  const [copiedPayload, setCopiedPayload] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  const qrRef = useRef(null);

  const generateQR = async () => {
    try {
      if (!text.trim()) {
        alert("Please enter some text");
        return;
      }

      const res = await axios.post("http://localhost:5000/generate-secure-qr", {
        text: text,
      });

      const quantumKey = res.data.quantum_key;
      const encryptedData = res.data.encrypted_data;
      const sessionId = res.data.session_id;
      const qrPayload = res.data.qr_payload;

      const payloadString = JSON.stringify(qrPayload);

      setQrValue(payloadString);
      setKey(quantumKey);
      setEncryptedText(encryptedData.ciphertext);
      setSessionId(sessionId);
      setQrPayloadText(payloadString);

      setCopiedPayload(false);
      setCopiedKey(false);

    } catch (error) {
      console.error(error);
      alert("Backend error. Check Flask server.");
    }
  };

  const copyToClipboard = async (data, type) => {
    try {
      await navigator.clipboard.writeText(data);

      if (type === "payload") {
        setCopiedPayload(true);
        setTimeout(() => setCopiedPayload(false), 2000);
      }

      if (type === "key") {
        setCopiedKey(true);
        setTimeout(() => setCopiedKey(false), 2000);
      }
    } catch (error) {
      console.error("Copy failed:", error);
    }
  };

  const downloadQR = () => {
    const canvas = qrRef.current?.querySelector("canvas");
    if (!canvas) return;

    const pngUrl = canvas
      .toDataURL("image/png")
      .replace("image/png", "image/octet-stream");

    const downloadLink = document.createElement("a");
    downloadLink.href = pngUrl;
    downloadLink.download = "secure-quantum-qr.png";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
  };

  return (
    <div className="container">
      <div className="card">
        <h1>Secure QR Code Generator</h1>
        <h2>Using Quantum Random Keys</h2>
        <p className="subtitle">
          Encrypt your secret data using a quantum-generated key and store it securely inside a QR code.
        </p>

        <textarea
          placeholder="Enter your secret message here..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows="4"
        />

        <button onClick={generateQR}>Generate Secure QR</button>

        {qrValue && (
          <div className="result-section" ref={qrRef}>
            <h3>Generated Secure QR</h3>
            <QRCodeCanvas value={qrValue} size={220} />
            <br />
            <button onClick={downloadQR} style={{ marginTop: "15px" }}>
              Download QR as PNG
            </button>
          </div>
        )}

        {sessionId && (
          <div className="info-box">
            <h3>Quantum Session ID</h3>
            <p>{sessionId}</p>
          </div>
        )}

        {encryptedText && (
          <div className="info-box">
            <h3>Encrypted Data</h3>
            <p>{encryptedText}</p>
          </div>
        )}

        {qrPayloadText && (
          <div className="info-box">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>QR Payload</h3>
              <button onClick={() => copyToClipboard(qrPayloadText, "payload")}>
                {copiedPayload ? "✅ Copied" : "📋 Copy"}
              </button>
            </div>
            <textarea value={qrPayloadText} readOnly rows="6" />
          </div>
        )}

        {key && (
          <div className="info-box key-box">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Quantum Secret Key</h3>
              <button onClick={() => copyToClipboard(key, "key")}>
                {copiedKey ? "✅ Copied" : "📋 Copy"}
              </button>
            </div>
            <p>{key}</p>
            <small>⚠ Save this key. It will be needed for decryption later.</small>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;