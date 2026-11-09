// template literal at char 885315..885451  body length 135  glsl-marker-hits 2
// context before: "e.setClearAlpha(r),this.overrideMaterial!==null&&(this.scene.overrideMaterial=o),e.autoClear=i}}const pB={uniforms:{tDiffuse:{value:null},luminosityThreshold:{value:1},smoothWidth:{value:1},defaultColor:{value:new ce(0)},defaultOpacity:{value:0}},vertexShader:"
// context after : ",fragmentShader:`\n\n\t\tuniform sampler2D tDiffuse;\n\t\tuniform vec3 defaultColor;\n\t\tuniform float defaultOpacity;\n\t\tuniform float luminosityThreshold;\n\t\tuniform float smoothWidth;\n\n\t\tvarying vec2 vUv;\n\n\t"
// ======================================================================


		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}
