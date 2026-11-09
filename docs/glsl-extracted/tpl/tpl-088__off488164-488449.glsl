// template literal at char 488164..488449  body length 284  glsl-marker-hits 4
// context before: "tion );\n\n\t\t\t\tgl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );\n\n\t\t\t}\n\t\t`,blending:ji,depthTest:!1,depthWrite:!1})}function E_(){return new Bt({name:\"CubemapToCubeUV\",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:Gv(),fragmentShader:"
// context after : ",blending:ji,depthTest:!1,depthWrite:!1})}function Gv(){return`\n\n\t\tprecision mediump float;\n\t\tprecision mediump int;\n\n\t\tattribute float faceIndex;\n\n\t\tvarying vec3 vOutputDirection;\n\n\t\tvec3 getDirecti"
// ======================================================================


			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		
