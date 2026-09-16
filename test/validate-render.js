// Download only the public schema; the Blueprint and secrets never leave this machine.
const fs = require('node:fs');
const YAML = require('yaml');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
(async () => {
  const response = await fetch('https://render.com/schema/render.yaml.json');
  if (!response.ok) throw new Error('Unable to download the Render schema: ' + response.status);
  const schema = await response.json();
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(YAML.parse(fs.readFileSync('render.yaml', 'utf8')))) {
    console.error(validate.errors); process.exitCode = 1;
  } else console.log('Render Blueprint matches the official schema.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
