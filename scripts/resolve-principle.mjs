import { realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, ...extra] = process.argv.slice(2);
if (extra.length || !/^principle-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? '')) {
  console.error('Invalid principle name. Expected principle-<slug>.');
  process.exitCode = 1;
} else {
  const skills = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills'));
  try {
    const leaf = realpathSync(join(skills, name, 'SKILL.md'));
    const pathFromSkills = relative(skills, leaf);
    if (pathFromSkills !== join(name, 'SKILL.md') || !statSync(leaf).isFile()) {
      throw new Error('Not a sibling skill file');
    }
    console.log(leaf);
  } catch {
    console.error(`Principle skill not found: ${name}`);
    process.exitCode = 1;
  }
}
