import { useState } from "react";
import axios from "axios";
import "./App.css";

function ScanDecrypt() {
  const [qrPayloadInput, setQrPayloadInput] = useState("");
  const [quantumKey, setQuantumKey] = useState("");
  const [decryptedText, setDecryptedText] = useState("");
  const [sessionId, setSessionId] = useState("");

  const handleDecrypt = async () => {
    try {
      if (!qrPayloadInput.trim() || !quantumKey.trim()) {
        alert("Please enter both QR payload and quantum key");
        return;
      }

      const parsedPayload = JSON.parse(qrPayloadInput);

      const res = await axios.post("http://localhost:5000/decrypt-secure-qr", {
        qr_payload: parsedPayload,
        quantum_key: quantumKey,
      });

      setDecryptedText(res.data.decrypted_text);
      setSessionId(res.data.session_id);
    } catch (error) {
      console.error(error);
      alert("Decryption failed. Check QR payload or secret key.");
    }
  };

  return (
    <div className="container">
      <div className="card">
        <h1>Scan & Decrypt Secure QR</h1>
        <h2>Receiver Side</h2>
        <p className="subtitle">
          Paste the QR payload and enter the quantum secret key to recover the original message.
        </p>

        <textarea
          placeholder="Paste QR payload here..."
          value={qrPayloadInput}
          onChange={(e) => setQrPayloadInput(e.target.value)}
          rows="6"
        />

        <textarea
          placeholder="Enter Quantum Secret Key..."
          value={quantumKey}
          onChange={(e) => setQuantumKey(e.target.value)}
          rows="3"
        />

        <button onClick={handleDecrypt}>Decrypt Secure QR</button>

        {sessionId && (
          <div className="info-box">
            <h3>Session ID</h3>
            <p>{sessionId}</p>
          </div>
        )}

        {decryptedText && (
          <div className="info-box key-box">
            <h3>Decrypted Original Message</h3>
            <p>{decryptedText}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default ScanDecrypt;