import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
// Twitter re-encodes anyway; this keeps the upload sharp without a huge file.
Config.setCrf(18);
