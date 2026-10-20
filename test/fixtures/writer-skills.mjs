import * as fs from 'node:fs/promises';
import path from 'node:path';

// Synthetic bodies only; caller owns and removes the enclosing test temp root.
export async function writerSkills(root) {
  const base = path.join(root, 'writer-skills');
  const skillPaths = [], skillReferenceDirectories = [];
  for (let i = 0; i < 4; i++) {
    const directory = path.join(base, `skill-${i}`);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'SKILL.md');
    await fs.writeFile(file, `---\n${i === 3 ? 'metadata:\n  version: "3.1.0"\n' : ''}---\n# Synthetic skill ${i}\nTest-only full skill body. [support](references/example.md)\n`, { flag: 'wx' });
    skillPaths.push(file);
    for (const name of ['agents', 'references', 'templates']) {
      const reference = path.join(directory, name);
      await fs.mkdir(reference);
      await fs.writeFile(path.join(reference, 'example.md'), '# Synthetic supporting material\n', { flag: 'wx' });
      skillReferenceDirectories.push(reference);
    }
  }
  return { skillPaths, skillReferenceDirectories };
}
