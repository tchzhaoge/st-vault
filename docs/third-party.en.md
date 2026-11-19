# Third-party components

[简体中文](third-party.md) · **English**

ST-Vault's original source is licensed under Apache-2.0. Dependency and system-component licenses remain applicable separately; this repository does not relicense them.

- Node.js and npm: upstream notices distributed with the official Node image.
- Fastify, React, Vite, Zod, Prettier, i18next and react-i18next: MIT.
- Timezone calculations use `@date-fns/tz` (MIT); its [upstream license](../licenses/date-fns-tz.txt) ships with the application.
- node-postgres (`pg`) and its runtime dependencies retain their upstream notices in the installed packages. PostgreSQL is embedded in the runtime and QA images and uses the PostgreSQL License. Preserve `/usr/share/doc` notices when redistributing the database image or binaries.
- Hls.js, Playwright and TypeScript: Apache-2.0.
- Chromium (QA only): installed from Debian packages; retain the distribution's component notices and comply with their respective licenses when redistributing images.
- Runtime FFmpeg: built from the Debian-patched FFmpeg source with GPL/nonfree components disabled, native decoders and libdav1d, and only the local MP4/JPEG pipeline enabled. The exact patched source archive, license and configure log are shipped in `/usr/local/share/doc/ffmpeg`; rebuild with `deploy/build-ffmpeg.sh` in the Docker media-build stage. QA uses Debian's full FFmpeg package, which may include GPL components. Neither component is relicensed by this project.

Third-party product names and API references identify compatibility; they do not imply affiliation or endorsement. The included application icon is inherited from the existing ST-Vault project. Contributors must verify the rights to any new asset before submitting it.

For exact versions see package-lock.json; inspect each installed package's LICENSE/NOTICE and the image's /usr/share/doc for complete terms.
