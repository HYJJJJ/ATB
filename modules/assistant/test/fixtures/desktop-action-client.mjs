import {executeDesktopAction} from '../../server/desktop-action-bridge.js';
const result=await executeDesktopAction(process.argv[2],'open_atb',{page:'tools'});
process.stdout.write(JSON.stringify(result));
