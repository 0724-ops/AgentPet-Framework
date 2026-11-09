// template literal at char 876051..876186  body length 134  glsl-marker-hits 2
// context before: "Listener(\"webglcontextrestored\",this.contextRestored),this.images.dispose(),this.renderer.dispose(),this.renderer.forceContextLoss(),this.renderer.domElement.remove()}}const iT={name:\"CopyShader\",uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:"
// context after : ",fragmentShader:`\n\n\t\tuniform float opacity;\n\n\t\tuniform sampler2D tDiffuse;\n\n\t\tvarying vec2 vUv;\n\n\t\tvoid main() {\n\n\t\t\tvec4 texel = texture2D( tDiffuse, vUv );\n\t\t\tgl_FragColor = opacity * texel;\n\n\n\t\t}`"
// ======================================================================


		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}
