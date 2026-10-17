/**
 * Persistence Service 的读取、快照和串行写入检查。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadService() {
  return H.compile(
    "src/services/persistenceService.ts",
    "persistence-service",
    []
  );
}

async function main() {
  const { DefaultPersistenceService } = loadService();
  const r = H.createReporter("Persistence Service 数据读写");

  {
    let loads = 0;
    const service = new DefaultPersistenceService(
      {
        async loadData() {
          loads++;
          return { marker: "loaded" };
        },
        async saveData() {},
      },
      { error() {} }
    );
    const loaded = await service.load();
    r.check(
      "load 委托给插件读取入口",
      loads === 1 && loaded && loaded.marker === "loaded"
    );
  }

  {
    const writes = [];
    const gate = deferred();
    const service = new DefaultPersistenceService(
      {
        async loadData() {
          return null;
        },
        async saveData(data) {
          writes.push(data);
          if (writes.length === 1) await gate.promise;
        },
      },
      { error() {} }
    );

    const firstPayload = { version: 1, nested: { value: 1 } };
    const first = service.save(firstPayload);
    firstPayload.nested.value = 2;
    const second = service.save({ version: 2, nested: { value: 2 } });

    await tick();
    r.check("第二次 save 会等待第一次完成", writes.length === 1);
    r.check(
      "save 在入队时冻结数据快照",
      writes[0]?.nested?.value === 1,
      String(writes[0]?.nested?.value)
    );

    gate.resolve();
    await first;
    await tick();
    r.check(
      "前一次完成后才启动下一次写入",
      writes.length === 2 && writes[1]?.version === 2
    );
    await second;
  }

  {
    const saved = [];
    const errors = [];
    const service = new DefaultPersistenceService(
      {
        async loadData() {
          return null;
        },
        async saveData(data) {
          if (data.version === 1) throw new Error("expected failure");
          saved.push(data.version);
        },
      },
      {
        error(...args) {
          errors.push(args);
        },
      }
    );

    let rejected = false;
    try {
      await service.save({ version: 1 });
    } catch (error) {
      rejected = error instanceof Error && error.message === "expected failure";
    }
    await service.save({ version: 2 });

    r.check("失败的写入会向调用方报错", rejected);
    r.check("失败不会毒化后续写入", saved.join(",") === "2");
    r.check("写入失败会记录日志", errors.length === 1);
  }

  {
    const gate = deferred();
    let loadStarted = false;
    const service = new DefaultPersistenceService(
      {
        async loadData() {
          loadStarted = true;
          return { version: 2 };
        },
        async saveData() {
          await gate.promise;
        },
      },
      { error() {} }
    );

    const write = service.save({ version: 2 });
    await tick();
    const load = service.load();
    await tick();
    r.check("load 会等待尚未完成的写入", !loadStarted);

    gate.resolve();
    await write;
    const loaded = await load;
    r.check(
      "写入结束后 load 读取最新数据",
      loadStarted && loaded && loaded.version === 2
    );
  }

  {
    let writes = 0;
    const service = new DefaultPersistenceService(
      {
        async loadData() {
          return null;
        },
        async saveData() {
          writes++;
        },
      },
      { error() {} }
    );
    const first = service.save({ version: 1 });
    const second = service.save({ version: 2 });
    await service.flush();
    await Promise.all([first, second]);
    r.check("flush 等待全部排队写入", writes === 2);
  }

  {
    const root = H.ROOT;
    const mainSource = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    const hostSource = fs.readFileSync(
      path.join(root, "src/host/pluginHost.ts"),
      "utf8"
    );
    const calls = mainSource.match(/await this\.persistPluginData\(\);/g) || [];

    r.check(
      "main.ts 不再直接调用 super.loadData",
      !/super\.loadData\s*\(/.test(mainSource)
    );
    r.check(
      "main.ts 不再直接调用 super.saveData",
      !/super\.saveData\s*\(/.test(mainSource)
    );
    r.check(
      "读取入口走 Host Persistence Service",
      /services\.persistence\.load\(\)/.test(mainSource)
    );
    r.check(
      "两个保存入口共用同一次持久化调用",
      calls.length === 2 &&
        /services\.persistence\.save\(/.test(mainSource)
    );
    r.check(
      "HostServices 暴露 persistence",
      /readonly persistence:\s*PersistenceService/.test(hostSource)
    );
  }

  return r.finish();
}

main()
  .then((ok) => {
    H.cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error("运行失败：" + error.stack);
    H.cleanup();
    process.exit(2);
  });
