## Transformers v5 release notes

<img width="1800" height="1013" alt="image" src="https://github.com/user-attachments/assets/7b5187d7-6945-4108-a546-6d1d7bfb55e3" />

- Highlights
- Significant API changes: dynamic weight loading, tokenization
- Backwards Incompatible Changes
- Bugfixes and improvements

We have a migration guide that will be continuously updated available on the `main` branch, please check it out in case you're facing issues: [migration guide](https://github.com/huggingface/transformers/blob/main/MIGRATION_GUIDE_V5.md).

## Highlights

We are excited to announce the initial release of Transformers v5. This is the first major release in five years, and the release is significant: 1200 commits have been pushed to `main` since the latest minor release. This release removes a lot of long-due deprecations, introduces several refactors that significantly simplify our APIs and internals, and comes with a large number of bug fixes.

We give an overview of our focus for this release in the [following blogpost](https://huggingface.co/blog/transformers-v5). In these release notes, we'll focus directly on the refactors and new APIs coming with v5.

This release is the full V5 release. **It sets in motion something bigger: going forward, starting with v5, we'll now release minor releases every week, rather than every 5 weeks. Expect v5.1 to follow next week, then v5.2 the week that follows, etc.**

We're moving forward with this change to ensure you have access to models as soon as they're supported in the library, rather than a few weeks after.

In order to install this release, please do so with the following:

```shell
pip install transformers
```

For us to deliver the best package possible, it is imperative that we have feedback on how the toolkit is currently working for you. Please try it out, and [open an issue](https://github.com/huggingface/transformers/issues/) in case you're facing something inconsistent/a bug.

Transformers version 5 is a community endeavor, and we couldn't have shipped such a massive release without the help of the entire community.

## Significant API changes

### Dynamic weight loading

We introduce a new weight loading API in `transformers`, which significantly improves on the previous API. This
weight loading API is designed to apply operations to the checkpoints loaded by transformers.

Instead of loading the checkpoint exactly as it is serialized within the model, these operations can reshape, merge,
and split the layers according to how they're defined in this new API. These operations are often a necessity when
working with quantization or parallelism algorithms.

This new API is centered around the new `WeightConverter` class:

```python
class WeightConverter(WeightTransform):
    operations: list[ConversionOps]
    source_keys: Union[str, list[str]]
    target_keys: Union[str, list[str]]
```

The weight converter is designed to apply a list of operations on the source keys, resulting in target keys. A common
operation done on the attention layers is to fuse the query, key, values layers. Doing so with this API would amount
to defining the following conversion:

```python
conversion = WeightConverter(
    ["self_attn.q_proj", "self_attn.k_proj", "self_attn.v_proj"],  # The input layers
    "self_attn.qkv_proj",  # The single layer as output
    operations=[Concatenate(dim=0)],
)
```

In this situation, we apply the `Concatenate` operation, which accepts a list of layers as input and returns a single 
layer. 

This allows us to define a mapping from architecture to a list of weight conversions. Applying those weight conversions
can apply arbitrary transformations to the layers themselves. This significantly simplified the `from_pretrained` method
and helped us remove a lot of technical debt that we accumulated over the past few years.

This results in several improvements:
- Much cleaner definition of transformations applied to the checkpoint
- Reversible transformations, so loading and saving a checkpoint should result in the same checkpoint
- Faster model loading thanks to scheduling of tensor materialization
- Enables complex mix of transformations that wouldn't otherwise be possible (such as quantization + MoEs, or TP + MoEs)

Linked PR: https://github.com/huggingface/transformers/pull/41580

### Tokenization

Just as we moved towards a single backend library for model definition, we want our tokenizers, and the `Tokenizer` object to be a lot more intuitive. With v5, tokenizer definition is much simpler; one can now initialize an empty `LlamaTokenizer` and train it directly on your corpus.

Defining a new tokenizer object should be as simple as this:

```python
from transformers import TokenizersBackend, generate_merges
from tokenizers import pre_tokenizers, Tokenizer
from tokenizers.model import BPE

class Llama5Tokenizer(TokenizersBackend):
    def __init__(self, unk_token="<unk>",bos_token="<s>", eos_token="</s>", vocab=None, merges=None ):
        if vocab is None:
            self._vocab = {
                str(unk_token): 0,
                str(bos_token): 1,
                str(eos_token): 2,
            }

        else:
            self._vocab = vocab

            self._merges = merges

        self._tokenizer = Tokenizer(
            BPE(vocab=self._vocab, merges=self._merges, fuse_unk=True)
        )
        self._tokenizer.pre_tokenizer = pre_tokenizers.Metaspace(
            replacement="▁", prepend_scheme=_get_prepend_scheme(self.add_prefix_space, self), split=False
        )
        super().__init__(
            tokenizer_object=self._tokenizer,
            unk_token=unk_token,
            bos_token=bos_token,
            eos_token=eos_token,
        )
```

Once the tokenizer is defined as above, you can load it with the following: `Llama5Tokenizer()`. Doing this returns you an empty, trainable tokenizer that follows the definition of the authors of `Llama5` (it does not exist yet :wink:).

The above is the main motivation towards refactoring tokenization: we want tokenizers to behave similarly to models: trained or empty, and with exactly what is defined in their class definition.

### Backend Architecture Changes: moving away from the slow/fast tokenizer separation

Up to now, transformers maintained two parallel implementations for many tokenizers:
- "Slow" tokenizers (`tokenization_<model>.py`) - Python-based implementations, often using [SentencePiece](https://github.com/google/sentencepiece) as the backend.
- "Fast" tokenizers (`tokenization_<model>_fast.py`) - Rust-based implementations using the 🤗 [tokenizers](https://github.com/huggingface/tokenizers) library.

In v5, we consolidate to a single tokenizer file per model: `tokenization_<model>.py`. This file will use the most appropriate backend available:

1. **TokenizersBackend** (preferred): Rust-based tokenizers from the 🤗 [tokenizers](https://github.com/huggingface/tokenizers) library. In general it provides optimal performance, but it also offers a lot more features that are commonly adopted across the ecosystem:
  - handling additional tokens
  - a full python API for setting and updating 
  - automatic parallelization,
  - automatic offsets
  - customization
  - training
2. **SentencePieceBackend**: for tokenizers requiring the `sentencepiece` library. It inherits from `PythonBackend`. 
3. **PythonBackend**: a Python implementations of the features provided by `tokenizers`. Basically allows adding tokens.
4. **MistralCommonBackend**: relies on `MistralCommon`'s tokenization library. (Previously known as the `MistralCommonTokenizer`)

The `AutoTokenizer` automatically selects the appropriate backend based on available files and dependencies. This is transparent, you continue to use `AutoTokenizer.from_pretrained()` as before. This allows transformers to be future-proof and modular to easily support future backends.

### Defining a tokenizers outside of the existing backends

We enable users and tokenizer builders to define their own tokenizers from top to bottom. Tokenizers are usually defined using a backend such as `tokenizers`, `sentencepiece` or `mistral-common`, but we offer the possibility to design the tokenizer at a higher-level, without relying on those backends.

To do so, you can import the `PythonBackend` (which was previously known as `PreTrainedTokenizer`). This class encapsulates all the logic related to added tokens, encoding, and decoding.

If you want something even higher up the stack, then `PreTrainedTokenizerBase` is what `PythonBackend` inherits from. It contains the very basic tokenizer API features: 
- `encode`
- `decode`
- `vocab_size`
- `get_vocab`
- `convert_tokens_to_ids`
- `convert_ids_to_tokens`
- `from_pretrained`
- `save_pretrained`
- among a few others

### API Changes

#### 1. Direct tokenizer initialization with vocab and merges

Starting with v5, we now enable initializing blank, untrained `tokenizers`-backed tokenizers:

```py
from transformers import LlamaTokenizer

tokenizer = LlamaTokenizer()
```

This tokenizer will therefore follow the definition of the `LlamaTokenizer` as defined in its class definition. It can then be trained on a corpus as can be seen in [the `tokenizers` documentation](https://huggingface.co/docs/tokenizers/training_from_memory).

These tokenizers can also be initialized from vocab and merges (if necessary), like the previous "slow" tokenizers:

```py
from transformers import LlamaTokenizer

vocab = {"<unk>": 0, "<s>": 1, "</s>": 2, "hello": 3, "world": 4}
merges = [("h", "e"), ("l", "l"), ("o", " ")]

tokenizer = LlamaTokenizer(vocab=vocab, merges=merges)
```

This tokenizer will behave as a Llama-like tokenizer, with an updated vocabulary. This allows comparing different tokenizer classes with the same vocab; therefore enabling the comparison of different pre-tokenizers, normalizers, etc.

⚠️ The `vocab_file` (as in, a path towards a file containing the vocabulary) cannot be used to initialize the `LlamaTokenizer` as loading from files is reserved to the `from_pretrained` method.

#### 2. Simplified decoding API

The `batch_decode` and `decode` methods have been unified to reflect behavior of the `encode` method. Both single and batch decoding now use the same `decode` method. See an example of the new behavior below:

```python
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained("t5-small") 
inputs = ["hey how are you?", "fine"]
tokenizer.decode(tokenizer.encode(inputs))
```

Gives:
```diff
- 'hey how are you?</s> fine</s>'
+ ['hey how are you?</s>', 'fine</s>']
```

We expect `encode` and `decode` to behave, as two sides of the same coin: `encode`, `process`, `decode`,  should work. 

> [!NOTE]
> A common use-case would be: `encode`, `model.generate`, `decode`.  However, using `generate` would return `list[list[int]]`, which would then be incompatible with `decode`.

#### 3. Unified encoding API

The `encode_plus` method is deprecated in favor of the single `__call__` method.

#### 4. `apply_chat_template` returns `BatchEncoding`

Previously, `apply_chat_template` returned `input_ids` for backward compatibility. Starting with v5, it now consistently returns a `BatchEncoding` dict like other tokenizer methods.

```python
# v5
messages = [
    {"role": "user", "content": "Hello!"},
    {"role": "assistant", "content": "Hi there!"}
]

# Now returns BatchEncoding with input_ids, attention_mask, etc.
outputs = tokenizer.apply_chat_template(messages, return_tensors="pt")
print(outputs.keys())  # dict_keys(['input_ids', 'attention_mask'])
```

#### 5. Removed legacy configuration file saving:

We simplify the serialization of tokenization attributes:

- `special_tokens_map.json` - special tokens are now stored in `tokenizer_config.json`.
- `added_tokens.json` - added tokens are now stored in `tokenizer.json`.
- `added_tokens_decoder` is only stored when there is no `tokenizer.json`.

When loading older tokenizers, these files are still read for backward compatibility, but new saves use the consolidated format. We're gradually moving towards consolidating attributes to fewer files so that other libraries and implementations may depend on them more reliably.

#### 6. Model-Specific Changes

Several models that had identical tokenizers now import from their base implementation:

- **LayoutLM** → uses BertTokenizer
- **LED** → uses BartTokenizer  
- **Longformer** → uses RobertaTokenizer
- **LXMert** → uses BertTokenizer
- **MT5** → uses T5Tokenizer
- **MVP** → uses BartTokenizer

These modules will eventually be removed altogether.

**Removed T5-specific workarounds**

The internal `_eventually_correct_t5_max_length` method has been removed. T5 tokenizers now handle max length consistently with other models.

### Testing Changes

A few testing changes specific to tokenizers have been applied:
- Model-specific tokenization test files now focus on integration tests.
- Common tokenization API tests (e.g., `add_tokens`, `encode`, `decode`) are now centralized and automatically applied across all tokenizers. This reduces test duplication and ensures consistent behavior

For legacy implementations, the original BERT Python tokenizer code (including `WhitespaceTokenizer`, `BasicTokenizer`, etc.) is preserved in `bert_legacy.py` for reference purposes.

#### 7. Deprecated / Modified Features

**Special Tokens Structure:**
- `SpecialTokensMixin`: Merged into `PreTrainedTokenizerBase` to simplify the tokenizer architecture.
- `special_tokens_map`: Now only stores named special token attributes (e.g., `bos_token`, `eos_token`). Use `extra_special_tokens` for additional special tokens (formerly `additional_special_tokens`). `all_special_tokens` includes both named and extra tokens.

```python
# v4
tokenizer.special_tokens_map  # Included 'additional_special_tokens'

# v5
tokenizer.special_tokens_map  # Only named tokens
tokenizer.extra_special_tokens  # Additional tokens
```

- `special_tokens_map_extended` and `all_special_tokens_extended`: Removed. Access `AddedToken` objects directly from `_special_tokens_map` or `_extra_special_tokens` if needed.
- `additional_special_tokens`: Still accepted for backward compatibility but is automatically converted to `extra_special_tokens`.

**Deprecated Methods:**
- `sanitize_special_tokens()`: Already deprecated in v4, removed in v5.
- `prepare_seq2seq_batch()`: Deprecated; use `__call__()` with `text_target` parameter instead.

```python
# v4
model_inputs = tokenizer.prepare_seq2seq_batch(src_texts, tgt_texts, max_length=128)

# v5
model_inputs = tokenizer(src_texts, text_target=tgt_texts, max_length=128, return_tensors="pt")
model_inputs["labels"] = model_inputs.pop("input_ids_target")
```

- `BatchEncoding.words()`: Deprecated; use `word_ids()` instead.

**Removed Methods:**
- `create_token_type_ids_from_sequences()`: Removed from base class. Subclasses that need custom token type ID creation should implement this method directly.
- `prepare_for_model()`, `build_inputs_with_special_tokens()`, `truncate_sequences()`: Moved from `tokenization_utils_base.py` to `tokenization_python.py` for `PythonBackend` tokenizers. `TokenizersBackend` provides model-ready input via `tokenize()` and `encode()`, so these methods are no longer needed in the base class.
- `_switch_to_input_mode()`, `_switch_to_target_mode()`, `as_target_tokenizer()`: Removed from base class. Use `__call__()` with `text_target` parameter instead.

```python
# v4
with tokenizer.as_target_tokenizer():
    labels = tokenizer(tgt_texts, ...)

# v5
labels = tokenizer(text_target=tgt_texts, ...)
```

- `parse_response()`: Removed from base class.

### Performance

#### MoE Performance

The v5 release significantly improves the performance of the MoE models, as can be seen in the graphs below. We improve and optimize MoE performance through batched and grouped experts implementations, and we optimize them for decoding using `batched_mm`.

<img width="2048" height="1451" alt="image" src="https://github.com/user-attachments/assets/c3f2e59f-3026-4f56-9a56-36e4eb0fcf73" />

#### Core performance

We focus on improving the performance of loading weights on device (which gives speedups up to 6x in tensor parallel situations); this is preliminary work that we'll continue to work on in the coming weeks. Some notable improvements:

- [saving] Simplify general logic by @Cyrilvallez in https://github.com/huggingface/transformers/pull/42766
- Do not rely on config for inferring model dtype by @Cyrilvallez in https://github.com/huggingface/transformers/pull/42838
- Improve BatchFeature: stack list and lists of torch tensors by @yonigozlan in https://github.com/huggingface/transformers/pull/42750
- Remove tied weights from internal attribute if they are not tied by @Cyrilvallez in https://github.com/huggingface/transformers/pull/42871
- Enforce call to post_init and fix all of them by @Cyrilvallez in https://github.com/huggingface/transformers/pull/42873
- Simplify tie weights logic by @Cyrilvallez in https://github.com/huggingface/transformers/pull/42895
- Add buffers to _init_weights for ALL models by @Cyrilvallez in https://github.com/huggingface/transformers/pull/42309
- [loading] Really initialize on meta device for huge perf gains by @Cyrilvallez in https://github.com/huggingface/transformers/pull/42941
- Do not use accelerate hooks if the device_map has only 1 device by @Cyrilvallez in https://github.com/huggingface/transformers/pull/43019
- Move missing weights and non-persistent buffers to correct device earlier by @Cyrilvallez in https://github.com/huggingface/transformers/pull/43021

## Library-wide changes with lesser impact

### Default `dtype` update

We have updated the default `dtype` for all models loaded with `from_pretrained` to be `auto`. This will lead to model instantiations respecting the `dtype` in which the model was saved, rather than forcing it to load in float 32.

You can, of course, still specify the `dtype` in which you want to load your model by specifying it as an argument to the `from_pretrained` method.

### Shard size

The Hugging Face Hub infrastructure has gradually moved to a XET backend. This will significantly simplify uploads and downloads, with higher download and upload speeds, partial uploads, and, most notably, a higher threshold for accepted file sizes on the Hugging Face Hub.

To reflect this, we're increasing the default shard size of models serialized on the Hub to 50GB (up from 5GB).

### `use_auth_token`

The `use_auth_token` argument/parameter is deprecated in favor of `token` everywhere.
You should be able to search and replace `use_auth_token` with `token` and get the same logic.

Linked PR: https://github.com/huggingface/transformers/pull/41666

### Attention-related features

We decided to remove some features for the upcoming v5 as they are currently only supported in a few old models and no longer integrated in current model additions. It's recommended to stick to v4.x in case you need them. Following features are affected:
- No more head masking, see [#41076](https://github.com/huggingface/transformers/pull/41076). This feature allowed to turn off certain heads during the attention calculation and only worked for eager.
- No more relative positional biases in Bert-like models, see [#41170](https://github.com/huggingface/transformers/pull/41170). This feature was introduced to allow relative position scores within attention calculations (similar to T5). However, this feature is barely used in official models and a lot of complexity instead. It also only worked with eager.
- No more head pruning, see [#41417](https://github.com/huggingface/transformers/pull/41417) by @gante. As the name suggests, it allowed to prune heads within your attention layers.

### Updates to supported torch APIs

We dropped support for two torch APIs:
- `torchscript` in https://github.com/huggingface/transformers/pull/41688
- `torch.fx` in https://github.com/huggingface/transformers/pull/41683

Those APIs were deprecated by the PyTorch team, and we're instead focusing on the supported APIs `dynamo` and `export`.

## Quantization changes

We clean up the quantization API in transformers, and significantly refactor the weight loading as highlighted
above.

We drop support for two quantization arguments that have been deprecated for some time:
- `load_in_4bit`
- `load_in_8bit`

We remove them in favor of the `quantization_config` argument which is much more complete. As an example, here is how
you would load a 4-bit bitsandbytes model using this argument:

```python
from transformers import AutoModelForCausalLM, BitsAndBytesConfig

quantization_config = BitsAndBytesConfig(load_in_4bit=True)

model_4bit = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.2-3B",
    device_map="auto",
    quantization_config=quantization_config
)
```

## Configuration

- Methods to init a nested config such as `from_xxx_config` are deleted. Configs can be init from the `__init__` method in the same way. See [#41314](https://github.com/huggingface/transformers/pull/41314).
- It is no longer possible to load a config class from a URL file. Configs must be loaded from either a local path or a repo on the Hub. See [#42383](https://github.com/huggingface/transformers/pull/42383).
- All parameters for configuring model's rotary embedding are now stored under `mode.rope_parameters`, including the `rope_theta` and `rope_type`. Model's `config.rope_parameters` is a simple dictionaty in most cases, and can also be a nested dict in special cases (i.e. Gemma3 and ModernBert) with different rope parameterization for each layer type. Trying to get `config.rope_theta` will throw an attribute error from now on. See [#39847](https://github.com/huggingface/transformers/pull/39847) and [#42255](https://github.com/huggingface/transformers/pull/42255)
- Qwen-VL family configuration is in a nested format and trying to access keys directly will throw an error (e.g. `config.vocab_size`). Users are expected to access keys from their respective sub-configs (`config.text_config.vocab_size`).
- Configurations of non-generative models (any model that doesn't call `model.generate()`) will no longer have a `generation_config` and `model.config.generation_config` will throw an attribute error.

## Processing

### Tokenization

- Slow tokenizer files (aka: `tokenization_<model>.py` ) will be removed in favor of using fast tokenizer files `tokenization_<model>_fast.py` --> will be renamed to `tokenization_<model>.py`.  As fast tokenizers are :hugs:`tokenizers` - backend, they include a wider range of features that are maintainable and reliable. 
- Other backends (sentence piece, tokenizers, etc.) will be supported with a light layer if loading a fast tokenizer fails
- Remove legacy files like special_tokens_map.json and added_tokens.json
- Remove _eventually_correct_t5_max_length 
- `encode_plus` --> `__call__`
- `batch_decode` --> `decode`

`apply_chat_template` by default returns naked `input_ids` rather than a `BatchEncoding` dict. 
This was inconvenient - it should return a `BatchEncoding` dict like `tokenizer.__call__()`, but we were stuck with 
it for backward compatibility. The method now returns a `BatchEncoding`.

Linked PRs: 
- https://github.com/huggingface/transformers/issues/40938
- https://github.com/huggingface/transformers/pull/40936
- https://github.com/huggingface/transformers/pull/41626

### Processing classes

- In processing classes each attribute will be serialized under `processor_config.json` as a nested dict, instead of serializing attributes in their own config files. Loading will be supported for all old format processors (https://github.com/huggingface/transformers/pull/41474)
- `XXXFeatureExtractors` classes are completely removed in favor of `XXXImageProcessor` class for all vision models (https://github.com/huggingface/transformers/pull/41174)
- Minor change: `XXXFastImageProcessorKwargs` is removed in favor of `XXXImageProcessorKwargs` which will be shared between fast and slow processors (https://github.com/huggingface/transformers/pull/40931)

## Modeling

- Some `RotaryEmbeddings` layers will start returning a dict of tuples, in case the model uses several RoPE configurations (Gemma2, ModernBert). Each value will be a tuple of "cos, sin" per RoPE type.
- Config attribute for `RotaryEmbeddings` layer will be unified and accessed via `config.rope_parameters`. Config attr for `rope_theta` might not be accessible anymore for some models, and instead will be in `config.rope_parameters['rope_theta']`. BC will be supported for a while as much as possible, and in the near future we'll gradually move to the new RoPE format  (https://github.com/huggingface/transformers/pull/39847)
- Vision Language models will not have a shortcut access to its language and vision component from the generative model via `model.language_model`. It is recommended to either access the module with `model.model.language_model` or `model.get_decoder()`. See [#42156](https://github.com/huggingface/transformers/pull/42156/)
- All models now accept `kwargs` in their forward methods

### Generate

- Old, deprecated output type aliases were removed (e.g. `GreedySearchEncoderDecoderOutput`). We now only have 4 output classes built from the following matrix: decoder-only vs encoder-decoder, uses beams vs doesn't use beams (https://github.com/huggingface/transformers/pull/40998)
- Removed deprecated classes regarding decoding methods that were moved to the Hub due to low usage (constraints and beam scores) (https://github.com/huggingface/transformers/pull/41223)
- If `generate` doesn't receive any KV Cache argument, the default cache class used is now defined by the model (as opposed to always being `DynamicCache`) (https://github.com/huggingface/transformers/pull/41505)
- Generation parameters are no longer accessible via model's config. If generation paramaters are serialized in `config.json` for any old model, it will be loaded back into model's generation config. Users are expected to access or modify generation parameters only with `model.generation_config.do_sample = True`. 

## Trainer

### New Features

* **ALST/Ulysses Sequence Parallelism Integration**
  - Added sequence parallelism support via HF Accelerate for training with longer sequences. Enables splitting sequences across devices using ALST (All-to-All Long Sequence Training) and Ulysses algorithms with DeepSpeed.
* **Improved `compute_loss_func` Handling**
  - `compute_loss_func` now always takes priority over the model's built-in loss computation, giving users consistent control over custom loss functions.
* **`num_items_in_batch` in Prediction Step**
  - The `num_items_in_batch` argument is now passed to `compute_loss` during `prediction_step`, enabling proper loss scaling during evaluation.

### Breaking Changes

* **`report_to` now defaults to `"none"`**
  - Logging integrations are no longer auto-detected by default; users must explicitly specify which reporting backends to use.

### Removing arguments without deprecation cycle in `TrainingArguments` due to low usage

- `mp_parameters` -> legacy param that was later on added to the Sagemaker trainer
- `_n_gpu` -> not intended for users to set, we will initialize it correctly instead of putting it in the `TrainingArguments`
- `overwrite_output_dir` - > replaced by `resume_from_checkpoint`, and it was only used in the examples script, no impact on Trainer. 
- `logging_dir` -> only used for tensorboard, set `TENSORBOARD_LOGGING_DIR` env var instead
- `jit_mode_eval` -> use `use_torch_compile` instead, as torchscript is not recommended anymore
- `tpu_num_cores`-> It is actually better to remove it, as it is not recommended to set the number of cores. By default, all TPU cores are used . Set `TPU_NUM_CORES` env var instead
- `past_index` -> it was only used for a very small number of models that have special architecture like transformersxl + it was not documented at all how to train those models
- `ray_scope` -> only for a minor arg for ray integration. Set `RAY_SCOPE` var env instead 
- `warmup_ratio` -> use `warmup_step` instead. We combined both args together by allowing passing float values in `warmup_step`. 

### Removing deprecated arguments in `TrainingArguments`

- `fsdp_min_num_params` and `fsdp_transformer_layer_cls_to_wrap` -> use `fsdp_config`
- `tpu_metrics_debug` -> `debug` 
- `push_to_hub_token` -> `hub_token`
- `push_to_hub_model_id` and `push_to_hub_organization` -> `hub_model_id`
- `include_inputs_for_metrics` -> `include_for_metrics`
- `per_gpu_train_batch_size` -> `per_device_train_batch_size`
- `per_gpu_eval_batch_size` -> `per_device_eval_batch_size`
- `use_mps_device` -> mps will be used by default if detected
- `fp16_backend` and `half_precision_backend` -> we will only rely on `torch.amp` as everything has been upstreamed to torch
- `no_cuda` -> `use_cpu`
- ` include_tokens_per_second` -> `include_num_input_tokens_seen`
- `use_legacy_prediction_loop` -> we only use `evaluation_loop` function from now on

### Removing deprecated arguments in `Trainer`

- `tokenizer` in initialization -> `processing_class`
- `model_path` in train() -> `resume_from_checkpoint`

### Removed features for `Trainer`

- sigpot integration for hp search was removed as the library was archived + the api stopped working
- drop support for sagemaker API <1.10
- bump accelerate minimum version to 1.1.0 
- bump peft minimum version to 0.18.0
- bump bitsandbytes minimum version to 0.46.1

###  New defaults for `Trainer`

- `use_cache` in the model config will be set to `False`. You can still change the cache value through `TrainingArguments` `usel_cache` argument if needed. 

## Pipeline

- Image text to text pipelines will no longer accept images as a separate argument along with conversation chats. Image data has to be embedded in the chat's "content" field. See [#42359](https://github.com/huggingface/transformers/pull/42359)
