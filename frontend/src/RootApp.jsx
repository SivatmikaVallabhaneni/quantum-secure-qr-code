import { useState } from "react";
import App from "./App";
import ScanDecrypt from "./ScanDecrypt";

function RootApp() {
  const [page, setPage] = useState("generate");

  return (
    <div>
      <div style={{ textAlign: "center", marginTop: "20px" }}>
        <button
          onClick={() => setPage("generate")}
          style={{ marginRight: "10px", padding: "10px 20px" }}
        >
          Generate QR
        </button>

        <button
          onClick={() => setPage("decrypt")}
          style={{ padding: "10px 20px" }}
        >
          Scan / Decrypt QR
        </button>
      </div>

      {page === "generate" ? <App /> : <ScanDecrypt />}
    </div>
  );
}

export default RootApp;