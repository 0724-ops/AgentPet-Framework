// template literal at char 488512..489333  body length 820  glsl-marker-hits 2
// context before: "\t\t\tvarying vec3 vOutputDirection;\n\n\t\t\tuniform samplerCube envMap;\n\n\t\t\tvoid main() {\n\n\t\t\t\tgl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );\n\n\t\t\t}\n\t\t`,blending:ji,depthTest:!1,depthWrite:!1})}function Gv(){return"
// context after : "}function pO(s){let e=new WeakMap,t=null;function n(a){if(a&&a.isTexture){const l=a.mapping,c=l===Ec||l===Rc,u=l===Os||l===vr;if(c||u){let h=e.get(a);const d=h!==void 0?h.texture.pmremVersion:0;if(a."
// ======================================================================


		precision mediump float;
		precision mediump int;

		attribute float faceIndex;

		varying vec3 vOutputDirection;

		vec3 getDirection( vec2 uv, float face ) {

			uv = 2.0 * uv - 1.0;

			vec3 direction = vec3( uv, 1.0 );

			if ( face == 0.0 ) {

				direction = direction.zyx;

			} else if ( face == 1.0 ) {

				direction = direction.xzy;
				direction.xz *= -1.0;

			} else if ( face == 2.0 ) {

				direction.x *= -1.0;

			} else if ( face == 3.0 ) {

				direction = direction.zyx;
				direction.xz *= -1.0;

			} else if ( face == 4.0 ) {

				direction = direction.xzy;
				direction.xy *= -1.0;

			} else if ( face == 5.0 ) {

				direction.z *= -1.0;

			}

			return direction;

		}

		void main() {

			vOutputDirection = getDirection( uv, faceIndex );
			gl_Position = vec4( position, 1.0 );

		}
	
