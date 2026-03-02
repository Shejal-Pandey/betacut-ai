import { pipeline, env } from '@huggingface/transformers';

async function run() {
    env.allowLocalModels = false;

    const segmenter = await pipeline('image-segmentation', 'Xenova/modnet');
    console.log("Segmenter loaded!");

    // Create a dummy image
    const imgUrl = "https://raw.githubusercontent.com/xenova/transformers.js/main/tests/assets/person.png"; // tiny 224x224 image

    const result = await segmenter(imgUrl);
    console.log(result.length, result[0].label, result[0].mask.width, result[0].mask.channels);
}
run();
