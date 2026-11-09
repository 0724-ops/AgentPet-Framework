// chunk "L4" — VFX fragment shader (tail)
// source chars 956100..957967; WHITESPACE-ONLY reformat of the verbatim body above.
// ${...} = JS template interpolation from the minified bundle.
// ============================================================================

uniform sampler2D Q163;
uniform sampler2D Q172;
uniform sampler2D Q79;
uniform sampler2D Q112;
uniform vec4 Q165,Q162,Q160,Q161;
uniform vec4 Q174,Q171,Q169,Q170;
uniform vec4 Q82,Q78,Q76,Q77;
uniform vec4 Q118,Q111,Q109,Q110;
uniform vec4 Q287;
uniform vec4 Q80;
uniform vec4 Q136;
uniform float Q101,Q74;
uniform float Q289,Q286;
uniform float Q164,Q294;
uniform float Q173,Q296;
uniform float Q81;
uniform float Q73,Q107,Q113,Q116;
uniform float Q304,Q298,Q254,Q158;
uniform float Q135,Q138,Q137,Q134;
uniform float Q312;

#ifdef Q45
varying vec4 Q314;
varying vec3 Q318;
varying float Q313;
varying float Q316;

#endif
vec2 R169() {

	#ifdef Q45
	if(Q304<=0.5)return vec2(0.0);
	vec2 R131=Q314.xy/Q314.w;
	vec2 s=vec2(R131.x,-R131.y/Q313);
	vec2 local=(viewMatrix*vec4(Q326-Q318,0.0)).xy;
	s=mix(s,local,Q158);
	float v=Q298!=0.0?Q326.y:s.y;
	float depth=max(-(viewMatrix*vec4(Q318,1.0)).z-Q316,1.0);
	return mix(1.0,depth,Q254)*vec2(s.x,v);

	#else
	return vec2(0.0);

	#endif

}
void main() {
	vec2 R197=R169();

	#ifdef Q42
	vec4 dt=R166(Q112,R189(Q118,Q111,Q109,Q110,R197));
	vec2 dist=R63(dt,Q73,Q107,Q113,Q116);

	#else
	vec2 dist=vec2(0.0);

	#endif
	vec4 R128=R47(R166(Q163,R189(Q165,Q162,Q160,Q161,R197)+dist*Q164),Q294);
	vec4 vc=mix(vColor,vec4(1.0),Q101);
	vec4 col=R128*vc*Q287*vec4(vec3(Q289),Q286);

	#ifdef Q44
	col*=R47(R166(Q172,R189(Q174,Q171,Q169,Q170,R197)+dist*Q173),Q296);

	#endif
	vec3 rgb=col.rgb;

	#ifdef Q41
	vec4 b=R166(Q79,R189(Q82,Q78,Q76,Q77,R197)+dist*Q81);
	vec4 R50=mix(vColor,vec4(1.0),Q74)*Q80;
	rgb+=clamp(R50.a*(col.a+b.a),0.0,1.0)*b.rgb*R50.rgb;

	#endif
	float a=col.a;

	#ifdef Q43
	a=clamp(a,0.0,1.0);
	vec3 N=normalize(Q325)*(gl_FrontFacing?1.0: -1.0);
	vec3 V=normalize(cameraPosition-Q326);
	float R80=pow(clamp(dot(V,N)+Q135,0.0,1.0),Q138);
	float F=mix(1.0-R80,R80,Q137);
	rgb=mix(rgb,Q136.rgb,F*Q136.a);
	a*=mix(1.0,F,Q134);

	#endif
	a=clamp(a*R132(),0.0,1.0);

	#ifdef Q48
	if(a<Q312)discard;

	#endif
	R228(rgb,a);

}

