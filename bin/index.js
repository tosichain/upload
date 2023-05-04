#! /usr/bin/env node
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
COPY --from=ghcr.io/tosichain/standard-stage2-loader:master@sha256:f9e1ab3b362f6539836d0de36e34146215bff5527b4f1f4d3106063468496b40 /stage2.squashfs /init_image/boot/stage2.squashfs
RUN mksquashfs /image /init_image/boot/contract.squashfs -reproducible -all-root -noI -noId -noF -noX -mkfs-time 0 -all-time 0
RUN CID=$(IPFS_PATH=/tmp/.ipfs ipfs --offline add -Q --cid-version=1 -r /init_image/) && IPFS_PATH=/tmp/.ipfs ipfs --offline dag export $CID > /init_image.car && echo -n "$CID" > /init_image.cid
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

const verifierContainer = "ghcr.io/tosichain/tosi-verifier:master@sha256:95c6ca885a345bc15462141e95c89a96726027011d40c1cf9869abec89899e5b";

const runResult = async (cid) => {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const build = spawn('docker', ["run", "-v", `${process.cwd()}:/data/ext-car`, `${verifierContainer}`, `/app/qemu-test-cid.sh`,
      `bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354`, `${cid}`, `bafybeihnujjp7cll46wrpw4tjxjfzphwzob6suzymfjswoparozveeh7zi`]);

    build.stdin.end();

    build.stdout.on('data', (data) => {
      process.stdout.write(data.toString());
      stdout = stdout + data.toString();
    });

    build.stderr.on('data', (data) => {
      process.stderr.write(data.toString());
      stderr = stderr + data.toString();
    });

    build.on('close', (code) => {
      if (code === 0) {
        const output = stdout.split("\n");
        resolve(output[output.length-1]);
      } else {
        reject(`docker run exited with code ${code}`);
      }
    });
  });
};


const getCID = async () => {
  return new Promise((resolve, reject) => {
    fs.readFile('init_image.cid', 'utf8', (err, data) => {
      if (err) {
        reject(`Error reading init_image.cid: ${err.message}`);
        return;
      }
      resolve(data);
    });
  });
};

(async () => {
  try {
    console.log(`Building image...`);
    await buildImage();
    const containerID = await createContainerAndGetID();
    await copyFiles(containerID);
    await cleanupContainer(containerID);
    const cid = await getCID();
    console.log(`Running image first time`);
    const result1 = await runResult(cid);
    console.log(`Running image again to make sure it's deterministic`);
    const result2 = await runResult(cid);
    if (result1.outputCID !== result2.outputCID) {
      throw new Error("output CIDs differ in subsequent runs");
    }
    if (result1.outputFileHash !== result2.outputFileHash) {
      throw new Error("output file hash differ in subsequent runs");
    }
    console.log(`Initial state CID: bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354`);
    console.log(`Initial input CID: ${cid}`);
    console.log(`Function CID: ${cid}`);
  } catch (error) {
    console.error(error);
  }
})();
