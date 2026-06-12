import { listWindows, shutdownHelper } from "../src/windows.js";

const N = 10;

const start = Date.now();
for (let i = 0; i < N; i++) {
  await listWindows({});
}
const elapsed = Date.now() - start;
console.log(`${N} listWindows() calls: ${elapsed}ms total, ${(elapsed / N).toFixed(1)}ms/call avg`);
shutdownHelper();
