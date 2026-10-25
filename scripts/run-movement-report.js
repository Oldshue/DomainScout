#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
async function main(args=process.argv.slice(2)){
 const at=args.indexOf('--config');if(at<0||!args[at+1])throw Error('Required --config path');const file=path.resolve(args[at+1]),config=JSON.parse(fs.readFileSync(file,'utf8'));
 if(config.environmentFile){if(!path.isAbsolute(config.environmentFile))throw Error('Absolute environmentFile is required');require('dotenv').config({path:config.environmentFile,quiet:true});}
 const report=await require('../server/movement-report-runner').runMovementReport(config);console.log(JSON.stringify(report));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
