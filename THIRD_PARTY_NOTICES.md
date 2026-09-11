# Third-Party Notices

## hls.js

- Component: hls.js
- Version: 1.7.2
- Source: https://github.com/video-dev/hls.js
- Distributed file: `app/public/vendor/hls.min.js`
- License copy: `app/public/vendor/hls.LICENSE.txt`
- License: Apache License 2.0

The bundled minified file is included so the dashboard can run without a
public CDN dependency. Update the JavaScript file, version in this notice, and
license copy together.

The hls.js browser bundle also contains `regenerator-runtime`, whose embedded
header identifies it as MIT-licensed software from the Babel project.

## MediaMTX and container images

HomeCam's Compose file references MediaMTX and the official Node.js container
image. Those images are downloaded separately and remain under their own
licenses. Review their upstream notices before redistributing container images.
