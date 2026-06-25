const fs = require('node:fs/promises');
const path = require('node:path');

async function cleanDistContents() {
  const distPath = path.resolve(process.cwd(), 'dist');
  await fs.mkdir(distPath, { recursive: true });
  const entries = await fs.readdir(distPath, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      fs.rm(path.join(distPath, entry.name), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

cleanDistContents().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
