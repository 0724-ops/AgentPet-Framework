// chunk "VB" — self-shadow debug pass
// source chars 908423..908775; WHITESPACE-ONLY reformat of the verbatim body above.
// ${...} = JS template interpolation from the minified bundle.
// ============================================================================

uniform vec3 Q85;
uniform vec2 Q133;
uniform vec4 Q261;
varying vec3 Q326;

/* ${aT} */
void main() {
	float t=clamp((Q133.x+Q133.y-distance(Q326,Q85))/Q133.y,0.0,1.0);
	float R77=t*t*(3.0-2.0*t);
	if(R77<=0.0)discard;
	float v=clamp(0.95-R57(Q326,vec3(0.0,1.0,0.0)),0.0,1.0)*Q261.a*R77;
	gl_FragColor=vec4(mix(vec3(1.0),Q261.rgb,v),1.0);

	#include <colorspace_fragment>

}

