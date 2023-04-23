const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.argv.length < 3) {
  console.error('Usage: node script.js <X>');
  process.exit(1);
}

const X = process.argv[2];
const dockerfile = `
FROM alpine:3.17 AS build
RUN apk add squashfs-tools kubo
COPY --from=${X} / /image
RUN IPFS_PATH=/tmp/.ipfs ipfs init --profile=server,flatfs,lowpower -e
RUN mkdir -p /init_image/boot
# make sure it's there
RUN mkdir -p /image/boot/initial
RUN cp -r /image/boot/initial /init_image/boot
RUN mksquashfs /image /init_image/boot/contract.squashfs -reproducible -all-root -noI -noId -noD -noF -noX -mkfs-time 0 -all-time 0
RUN CID=$(IPFS_PATH=/tmp/.ipfs ipfs --offline add -Q --cid-version=1 -r /init_image/) && IPFS_PATH=/tmp/.ipfs ipfs --offline dag export $CID > /init_image.car && echo "CID: $CID" > /init_image.cid
`

const buildImage = async () => {
  return new Promise((resolve, reject) => {
    const build = spawn('docker', ['build', '-t', `${X}-tosi`, '-']);

    build.stdin.write(dockerfile);
    build.stdin.end();

    build.stdout.on('data', (data) => {
      console.log(data.toString());
    });

    build.stderr.on('data', (data) => {
      console.error(data.toString());
    });

    build.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(`docker build exited with code ${code}`);
      }
    });
  });
};

const createContainerAndGetID = async () => {
  return new Promise((resolve, reject) => {
    exec(`docker create ${X}-tosi`, (error, stdout, stderr) => {
      if (error) {
        reject(`Error creating container: ${error.message}`);
        return;
      }
      if (stderr) {
        reject(`Error creating container: ${stderr}`);
        return;
      }
      resolve(stdout.trim());
    });
  });
};

const copyFiles = async (containerID) => {
  return new Promise((resolve, reject) => {
    exec(`docker cp ${containerID}:/init_image.car . && docker cp ${containerID}:/init_image.cid .`, (error, stdout, stderr) => {
      if (error) {
        reject(`Error copying files: ${error.message}`);
        return;
      }
      if (stderr) {
        reject(`Error copying files: ${stderr}`);
        return;
      }
      resolve();
    });
  });
};

const cleanupContainer = async (containerID) => {
  return new Promise((resolve, reject) => {
    exec(`docker stop ${containerID} && docker rm ${containerID}`, (error, stdout, stderr) => {
      if (error) {
        reject(`Error cleaning up container: ${error.message}`);
        return;
      }
      if (stderr) {
        reject(`Error cleaning up container: ${stderr}`);
        return;
      }
      resolve();
    });
  });
};

const printCID = async () => {
  return new Promise((resolve, reject) => {
    fs.readFile(path.join(__dirname, 'init_image.cid'), 'utf8', (err, data) => {
      if (err) {
        reject(`Error reading init_image.cid: ${err.message}`);
        return;
      }
      console.log(`CID: ${data}`);
      resolve();
    });
  });
};

(async () => {
  try {
    await buildImage();
    const containerID = await createContainerAndGetID();
    await copyFiles(containerID);
    await cleanupContainer(containerID);
    await printCID();
  } catch (error) {
    console.error(error);
  }
})();
