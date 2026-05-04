import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const hubBundle = resolve(repoRoot, "dist", "advantagescope", "bundles", "hub.js");

const injection = `;(()=>{const p=new URLSearchParams(window.location.search),path=p.get("nt4Path"),origin=p.get("nt4Origin")||window.location.origin;if(!path)return;window.__ascopeNt4Alive=()=>fetch(origin+path.replace(/\\/nt4$/,"/alive"),{signal:AbortSignal.timeout(250)});window.__ascopeNt4Ws=(app,rtt)=>{const u=new URL(origin);u.protocol=u.protocol==="https:"?"wss:":"ws:";u.pathname=path;u.search="";u.hash="";return new WebSocket(u.toString(),rtt?["rtt.networktables.first.wpi.edu"]:["v4.1.networktables.first.wpi.edu","networktables.first.wpi.edu"])};})();`;

const replacements: Array<[string, string]> = [
  [
    `e=await Promise.any(this.serverPorts.map((e=>fetch("http://"+this.serverAddr+":"+e.toString(),{signal:AbortSignal.timeout(250)}))))`,
    `e=await(window.__ascopeNt4Alive?window.__ascopeNt4Alive():Promise.any(this.serverPorts.map((e=>fetch("http://"+this.serverAddr+":"+e.toString(),{signal:AbortSignal.timeout(250)})))))`,
  ],
  [
    `let t=new WebSocket("ws://"+this.serverAddr+":"+this.activeServerPort.toString()+"/nt/"+this.appName,e?["rtt.networktables.first.wpi.edu"]:["v4.1.networktables.first.wpi.edu","networktables.first.wpi.edu"])`,
    `let t=(window.__ascopeNt4Ws?window.__ascopeNt4Ws(this.appName,e):null)||new WebSocket("ws://"+this.serverAddr+":"+this.activeServerPort.toString()+"/nt/"+this.appName,e?["rtt.networktables.first.wpi.edu"]:["v4.1.networktables.first.wpi.edu","networktables.first.wpi.edu"])`,
  ],
];

let source = readFileSync(hubBundle, "utf8");
if (source.includes("__ascopeNt4Ws")) {
  console.log("AS Lite NT4 proxy patch already present.");
  process.exit(0);
}

source = `${injection}\n${source}`;

for (const [needle, replacement] of replacements) {
  if (!source.includes(needle)) {
    throw new Error(`Could not find expected AS Lite bundle text: ${needle.slice(0, 80)}...`);
  }
  source = source.replace(needle, replacement);
}

writeFileSync(hubBundle, source);
console.log(`Patched ${hubBundle} to support nt4Origin/nt4Path query params.`);
