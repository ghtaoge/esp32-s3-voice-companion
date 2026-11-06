'use strict';
const fs=require('node:fs');
const path=require('node:path');

const args=process.argv.slice(2);
const get=name=>{const index=args.indexOf(name);return index<0?'':args[index+1]||'';};
const appid=get('--appid');
if (!/^wx[0-9a-f]{16}$/.test(appid)) {
  process.stderr.write('Usage: node scripts/prepare.js --appid YOUR_WECHAT_APPID\n');
  process.exitCode=1;
} else {
  const source=path.resolve(__dirname,'..');
  const output=path.join(source,'.local','wechat');
  fs.mkdirSync(output,{recursive:true});
  const files=['app.js','app.json','app.wxss','theme.json','sitemap.json','project.config.json','pages','utils'];
  files.forEach(name=>fs.cpSync(path.join(source,name),path.join(output,name),{recursive:true}));
  const config=JSON.parse(fs.readFileSync(path.join(output,'project.config.json'),'utf8'));
  config.appid=appid;
  config.projectname+='-local';
  fs.writeFileSync(path.join(output,'project.config.json'),JSON.stringify(config,null,2)+'\n');
  process.stdout.write('Local WeChat project prepared in miniprogram/.local/wechat. Import that directory in WeChat DevTools.\n');
}
