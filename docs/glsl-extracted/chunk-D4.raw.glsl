// chunk "D4" — VFX fragment shader (base v2)
// source chars 957973..961570 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

uniform sampler2D Q163;uniform vec4 Q165,Q162,Q160,Q161;
#if Q36 > 0
uniform sampler2D Q246;uniform vec4 Q216,Q215,Q213,Q214,Q212;uniform float Q217,Q299;
#endif
#if Q36 > 1
uniform sampler2D Q247;uniform vec4 Q223,Q221,Q219,Q220,Q218;uniform float Q224,Q300,Q222;
#endif
#if Q36 > 2
uniform sampler2D Q248;uniform vec4 Q230,Q228,Q226,Q227,Q225;uniform float Q231,Q301,Q229;
#endif
#if Q36 > 3
uniform sampler2D Q249;uniform vec4 Q237,Q235,Q233,Q234,Q232;uniform float Q238,Q302,Q236;
#endif
#if Q36 > 4
uniform sampler2D Q250;uniform vec4 Q244,Q242,Q240,Q241,Q239;uniform float Q245,Q303,Q243;
#endif
uniform vec4 Q287;uniform vec4 Q80;uniform vec4 Q103;uniform vec4 Q136;uniform float Q101,Q289,Q286;uniform float Q125,Q124;uniform float Q164,Q294;uniform float Q292,Q293,Q295,Q305,Q291;uniform float Q73,Q107,Q113,Q116;uniform float Q108,Q114,Q117,Q115;uniform float Q311,Q106;uniform float Q102,Q105,Q104;uniform float Q135,Q138,Q137,Q134;
#ifdef Q46
uniform sampler2D Q251;uniform float Q252;uniform float Q276,Q275;uniform mat4 projectionMatrix;
#endif
float R191(){
#ifdef Q46
if(Q252<0.5)return 1.0;if(Q252>1.5)return 0.0;vec4 view=viewMatrix*vec4(Q326,1.0);vec4 clip=projectionMatrix*view;vec2 screen=clip.xy/clip.w*0.5+0.5;float R131=texture2D(Q251,screen).x*2.0-1.0;float R167=projectionMatrix[3][2]/(R131+projectionMatrix[2][2]);return clamp((abs(R167)-abs(view.z)+Q275)/Q276,0.0,1.0);
#else
return 1.0;
#endif
}void R48(vec4 s,vec4 R22,float R33,inout float weight,inout vec4 mask,inout vec4 blend,inout float R133){weight+=s.x*R22.y;mask+=s*R22.z;blend+=s*R22.w;R133+=s.x*R33;}void main(){vec4 col=(Q101!=0.0?vec4(1.0):vColor)*Q287*vec4(vec3(Q289),Q286);vec2 dist=vec2(0.0);float weight=1.0-Q305;vec4 mask=vec4(1.0-Q295);vec4 blend=vec4(0.0);float R133=0.0;
#if Q36 > 0
vec4 s0=R47(R166(Q246,R189(Q216,Q215,Q213,Q214,vec2(0.0),Q34.y)),Q299);
#ifdef Q39
vec4 d1=s0;
#else
vec4 d1=vec4(s0.xy*Q212.x,0.0,s0.w*Q212.x)+(1.0-Q292);
#endif
if(Q212.x!=0.0)dist=R63(d1,Q73,Q107,Q113,Q116);R48(s0,Q212,Q217,weight,mask,blend,R133);
#endif
#if Q36 > 1
vec4 s1=R47(R166(Q247,R189(Q223,Q221,Q219,Q220,vec2(0.0),Q34.y)+dist*Q222),Q300);vec4 d2=vec4(s1.xy*Q218.x,0.0,s1.w*Q218.x)+(1.0-Q292*Q293);if(Q218.x!=0.0)dist+=R63(d2,Q73,Q108,Q114,Q117);R48(s1,Q218,Q224,weight,mask,blend,R133);dist*=mix(1.0,weight,Q218.y*Q311*Q115);
#endif
#if Q36 > 2
vec4 s2=R47(R166(Q248,R189(Q230,Q228,Q226,Q227,vec2(0.0),Q34.y)+dist*Q229),Q301);R48(s2,Q225,Q231,weight,mask,blend,R133);dist*=mix(1.0,weight,Q225.y*Q311*Q115);
#endif
#if Q36 > 3
vec4 s3=R47(R166(Q249,R189(Q237,Q235,Q233,Q234,vec2(0.0),Q34.y)+dist*Q236),Q302);R48(s3,Q232,Q238,weight,mask,blend,R133);dist*=mix(1.0,weight,Q232.y*Q311*Q115);
#endif
#if Q36 > 4
vec4 R164=R47(R166(Q250,R189(Q244,Q242,Q240,Q241,vec2(0.0),Q34.y)+dist*Q243),Q303);R48(R164,Q239,Q245,weight,mask,blend,R133);dist*=mix(1.0,weight,Q239.y*Q311*Q115);
#endif
vec4 R128=R47(R166(Q163,R189(Q165,Q162,Q160,Q161,vec2(0.0),Q34.x)+dist*Q164),Q294);col*=R128;vec4 R130=col*mask;vec3 rgb=R130.rgb+clamp((col.a*mask.a+blend.a)*Q80.a,0.0,1.0)*blend.rgb*Q80.rgb;float a=R130.a;if(Q291!=0.0){float k=Q311*Q106;float R168=(Q34.z+Q105)*2.02-0.01;float d=R133-((weight*k+1.0-k)*R168-1.0);float edge=clamp((Q104-d)*Q102,0.0,1.0);rgb=mix(rgb,edge*Q103.rgb*Q289,edge);a=clamp(d*Q102,0.0,1.0)*R130.a;}
#ifdef Q40
a=clamp(a,0.0,1.0);vec3 V=normalize(cameraPosition-Q326);float R80=pow(clamp(dot(V,Q325)+Q135,0.0,1.0),Q138);float F=mix(1.0-R80,R80,Q137);rgb=mix(rgb,Q136.rgb,F*Q136.a);a*=mix(1.0,F,Q134);
#endif
rgb+=max(rgb-Q125,0.0)*Q124;a=clamp(R132()*(a*R191()),0.0,1.0);R228(max(rgb,0.0),a);}

