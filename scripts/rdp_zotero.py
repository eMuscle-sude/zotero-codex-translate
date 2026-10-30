"""Drive the dedicated test profile through its loopback Gecko developer protocol.

The endpoint is enabled only on the disposable test profile. It is never enabled
on the user's profile. Close that test Zotero after tests.
"""
import argparse
import json
from pathlib import Path
import socket
import time

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "plugin/manifest.json").read_text(encoding="utf-8"))["version"]
parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["inspect", "install", "eval"])
parser.add_argument("--script", type=Path)
args = parser.parse_args()
sock = socket.create_connection(("127.0.0.1", 6049), timeout=15)
sock.settimeout(15)
buffer = b""


def receive():
    global buffer
    while b":" not in buffer:
        buffer += sock.recv(65536)
    number, buffer = buffer.split(b":", 1)
    count = int(number)
    while len(buffer) < count:
        data = sock.recv(65536)
        if not data: raise EOFError()
        buffer += data
    data, buffer = buffer[:count], buffer[count:]
    return json.loads(data)


def request(to, type, **values):
    packet = json.dumps({"to": to, "type": type, **values}).encode()
    sock.sendall(str(len(packet)).encode() + b":" + packet)
    while True:
        response = receive()
        if response.get("from") == to:
            return response


receive()
process = request("root", "getProcess", id=0)["processDescriptor"]["actor"]
target = request(process, "getTarget")
form = target.get("process", target.get("target", target))
console = form.get("consoleActor")
if not console:
    print(json.dumps(target, indent=2))
    raise SystemExit("No console actor")


def evaluate(script):
    response = request(console, "evaluateJSAsync", text=script, options={})
    if "error" in response:
        return response
    while True:
        packet = receive()
        if packet.get("type") == "evaluationResult" and packet.get("resultID") == response.get("resultID"):
            return packet


check = evaluate('Services.dirsvc.get("ProfD", Ci.nsIFile).path')
if check.get("result") != str(root / "tmp/zotero-test-profile"):
    print(check)
    raise RuntimeError("Refusing to operate outside dedicated test profile")
report = root / f"tmp/rdp-{args.action}.json"
if report.exists():
    report.unlink()
prefix = '''(async()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");
 const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
 try {const result=await (async()=>{'''
suffix = '''})(); await IOUtils.writeJSON(REPORT,result); }catch(e){await IOUtils.writeJSON(REPORT,{error:String(e),stack:e.stack,additional:e.additionalErrors});}})()'''.replace("REPORT", json.dumps(str(report)))
if args.action == "inspect":
    script = '''return {addons:(await AddonManager.getAllAddons()).map(a=>({id:a.id,active:a.isActive,disabled:a.appDisabled,userDisabled:a.userDisabled})),
      api:!!Zotero.CodexPDFTranslate,errors:Services.console.getMessageArray().map(x=>x.message).filter(x=>/codex|invalid|manifest|Error/i.test(x)).slice(-40)};'''
elif args.action == "install":
    script = '''const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(XPI);
      const i=await AddonManager.getInstallForFile(file);
      if(i.error) return {error:i.error,state:i.state,addon:i.addon?.id};
      return await new Promise(resolve=>{i.addListener({onInstallEnded:(i,a)=>resolve({id:a.id,active:a.isActive}),
      onInstallFailed:i=>resolve({error:i.error,state:i.state})});i.install();});'''.replace("XPI",json.dumps(str(root / f"dist/zotero-codex-translate-{version}.xpi")))
else:
    script = args.script.read_text(encoding="utf-8")
evaluation = evaluate(prefix + script + suffix)
if evaluation.get("hasException") or evaluation.get("error"):
    print(json.dumps(evaluation, ensure_ascii=False, indent=2))
for _ in range(100):
    if report.exists():
        print(report.read_text(encoding="utf-8"))
        break
    time.sleep(0.1)
sock.close()
