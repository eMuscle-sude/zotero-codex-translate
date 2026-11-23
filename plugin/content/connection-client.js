/* global Zotero, Services, Cc, Ci, IOUtils, PathUtils */
var CodexPDFConnections = {
  create(api) {
    return {
      url: "", token: "", starting: null,
      async raw(method, path, body) {
        const options = { responseType: "json", timeout: 30000, debug: false, logBodyLength: 0,
          headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
          successCodes: [200, 400, 403, 404, 500] };
        if (body !== undefined) options.body = JSON.stringify(body);
        const response = await Zotero.HTTP.request(method, this.url + path, options);
        const result = response.response;
        if (response.status !== 200) throw new Error(result?.error || "模型连接操作失败，请重试。");
        return result;
      },
      async ensure() {
        if (this.starting) return this.starting;
        if (this.url) {
          try { await this.raw("GET", "/health"); return; }
          catch (error) { this.url = ""; }
        }
        this.starting = (async () => {
          const python = await api.resolvePython();
          const directory = PathUtils.join(api.stateDir, "control", Zotero.Utilities.randomString(16));
          await IOUtils.makeDirectory(directory, { ignoreExisting: true });
          this.token = Services.uuid.generateUUID().toString().replace(/[^a-f0-9]/gi, "") + Services.uuid.generateUUID().toString().replace(/[^a-f0-9]/gi, "");
          const request = PathUtils.join(directory, "request.json");
          await IOUtils.writeJSON(request, { stateDir: api.stateDir, token: this.token,
            codexPath: api.getPref("codexPath", api.settings.codexPath || "") });
          const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
          process.init(Zotero.File.pathToFile(python));
          const args = ["-X", "utf8", api.connectionPath, "--request", request];
          process.runwAsync(args, args.length);
          const descriptor = PathUtils.join(directory, "endpoint.json");
          for (let i = 0; i < 100; i++) {
            if (await IOUtils.exists(descriptor)) {
              const data = await IOUtils.readJSON(descriptor);
              if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw new Error("本机连接服务返回了无效端口。");
              this.url = "http://127.0.0.1:" + data.port;
              await this.raw("GET", "/health");
              return;
            }
            await Zotero.Promise.delay(100);
          }
          throw new Error("模型连接服务未能启动，请检查 Python 路径后重试。");
        })();
        try { return await this.starting; }
        finally { this.starting = null; }
      },
      async request(path = "/state", body) {
        await this.ensure();
        const result = await this.raw(body === undefined ? "GET" : "POST", path, body);
        if (result.connections) api.connectionSettings = result.connections;
        return result;
      },
      async stop() {
        if (this.url) {
          try { await this.raw("POST", "/shutdown", {}); } catch (error) { /* Already stopped. */ }
        }
        this.url = "";
      },
    };
  },
};
