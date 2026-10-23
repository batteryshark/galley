import * as fs from 'node:fs/promises';
import path from 'node:path';
import { writerSkills } from './writer-skills.mjs';

export async function writerToolInputs(root) {
  const skills = await writerSkills(root);
  const imageSkill = path.join(root, 'image-skill.md'), chiefFile = path.join(root, 'chief.json');
  await fs.writeFile(imageSkill, '# Synthetic image tool guidance\n');
  await fs.writeFile(chiefFile, JSON.stringify({ session: 'ses_chief', directory: root }));
  return { ...skills, writerTools: { imageCommand: await fs.realpath(process.execPath), imageSkill, chiefFile, home: root } };
}
