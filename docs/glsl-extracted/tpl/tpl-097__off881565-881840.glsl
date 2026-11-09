// template literal at char 881565..881840  body length 274  glsl-marker-hits 4
// context before: "e){this._pixelRatio=e,this.setSize(this._width,this._height)}dispose(){this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.copyPass.dispose()}}const hB={name:\"OutputShader\",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:"
// context after : ",fragmentShader:`\n\t\n\t\tprecision highp float;\n\n\t\tuniform sampler2D tDiffuse;\n\n\t\t#include <tonemapping_pars_fragment>\n\t\t#include <colorspace_pars_fragment>\n\n\t\tvarying vec2 vUv;\n\n\t\tvoid main() {\n\n\t\t\tgl_"
// ======================================================================

		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}
