"use strict";

class Craft3D {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      75,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      1000,
    );
    // move the camera away from the model
    this.camera.position.z = 200;
    this.scene.add(this.camera);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.8);
    directionalLight.position.set(0, 600, 800);
    this.scene.add(directionalLight);

    // modelWrapper adds an extra axis of rotation to avoid gimbal lock with the euler angles
    this.modelWrapper = new THREE.Object3D();
    this.scene.add(this.modelWrapper);

    const loader = new THREE.GLTFLoader();
    loader.load("/resources/models/model.gltf", (gltf) => {
      this.model = gltf.scene;
      // wingflight-configurator's own 3D view (src/js/model.js) uses 15x for this same
      // model file, but under a different camera (FOV 50, z=125) than this one (FOV 75,
      // z=200 above); tuned up from that starting point to read as a reasonable size here.
      this.model.scale.set(21, 21, 21);
      this.modelWrapper.add(this.model);
      this.render();
    });
  }

  rotateTo(x, y, z) {
    if (!this.model) return;

    this.model.rotation.x = x;
    this.modelWrapper.rotation.y = y;
    this.model.rotation.z = z;
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width, height) {
    if (this.canvas.width != width || this.canvas.height != height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.render();
    }
  }
}
