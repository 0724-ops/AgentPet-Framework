// template literal at char 876203..876385  body length 181  glsl-marker-hits 4
// context before: "ement.remove()}}const iT={name:\"CopyShader\",uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`\n\n\t\tvarying vec2 vUv;\n\n\t\tvoid main() {\n\n\t\t\tvUv = uv;\n\t\t\tgl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );\n\n\t\t}`,fragmentShader:"
// context after : "};class vl{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error(\"THREE.Pass: .render() must be implemented in derived "
// ======================================================================


		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}
