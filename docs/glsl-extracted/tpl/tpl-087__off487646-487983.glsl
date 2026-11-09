// template literal at char 487646..487983  body length 336  glsl-marker-hits 3
// context before: "ta, axis );\n\t\t\t\t\tgl_FragColor.rgb += weights[ i ] * getSample( theta, axis );\n\n\t\t\t\t}\n\n\t\t\t}\n\t\t`,blending:ji,depthTest:!1,depthWrite:!1})}function A_(){return new Bt({name:\"EquirectangularToCubeUV\",uniforms:{envMap:{value:null}},vertexShader:Gv(),fragmentShader:"
// context after : ",blending:ji,depthTest:!1,depthWrite:!1})}function E_(){return new Bt({name:\"CubemapToCubeUV\",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:Gv(),fragmentShader:`\n\n\t\t\tprecision med"
// ======================================================================


			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		
