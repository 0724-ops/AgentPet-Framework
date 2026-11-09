// chunk "h4" — character vertex shader
// source chars 924490..925014; WHITESPACE-ONLY reformat of the verbatim body above.
// ${...} = JS template interpolation from the minified bundle.
// ============================================================================

#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv;
varying vec3 Q325;
varying vec3 Q326;

#ifdef Q23
#ifndef USE_UV1
attribute vec2 uv1;

#endif
varying vec2 Q321;

#endif
void main() {
	vUv=uv;

	#ifdef Q23
	Q321=uv1;

	#endif
	vec3 objectNormal=vec3(normal);

	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <begin_vertex>
	#include <skinning_vertex>
	vec4 R227=modelMatrix*vec4(transformed,1.0);
	Q326=R227.xyz;
	Q325=normalize(mat3(modelMatrix)*objectNormal);
	gl_Position=projectionMatrix*viewMatrix*R227;

}

